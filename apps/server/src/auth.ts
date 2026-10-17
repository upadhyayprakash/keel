import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { randomBytes } from 'node:crypto';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { checkTotp, KeelError, parsePublicUrl, type AuthStore, type Session, type SessionScope } from '@keel/core';

// ADR 0002: passkey login when `keel serve` leaves localhost. Pairing needs a
// one-time token from `keel auth passkey add`; sign-in uses a discoverable
// passkey, so there is no username. Two cookies, one per scope, so signing in to
// the browser terminal never shortens the Goals session.

export interface AuthOptions {
  store: AuthStore;
  /** `--public-url`: the passkey hostname and expected origin. Without it, passkeys can't be used. */
  publicUrl?: string;
  /** Reads the TOTP secret from the secret store, when `keel auth totp enable` has set one. */
  totpSecret?: () => Promise<string | null>;
  /** For tests. */
  now?: () => number;
}

export const COOKIES: Record<SessionScope, string> = { goals: 'keel_goals', terminal: 'keel_terminal' };
const CHALLENGE_TTL = 5 * 60_000;
/** Failed pairings and sign-ins allowed per minute before Keel answers 429. */
const MAX_FAILURES = 10;
/** Wrong TOTP codes allowed per minute before Keel slows down (ADR 0002). */
const MAX_WRONG_CODES = 5;

type Json = Record<string, unknown>;
const isScope = (value: unknown): value is SessionScope => value === 'goals' || value === 'terminal';

/** Rejects anything but a JSON body, like the rest of the API. */
async function body(c: Context): Promise<Json | null> {
  if (!c.req.header('content-type')?.startsWith('application/json')) return null;
  const value = await c.req.json<unknown>().catch(() => null);
  return value && typeof value === 'object' ? (value as Json) : null;
}

const problem = (c: Context, status: 400 | 401 | 403 | 409 | 415 | 429, error: string, hint?: string) => c.json({ error, ...(hint ? { hint } : {}) }, status);

function setSession(c: Context, scope: SessionScope, token: string, session: Session): void {
  setCookie(c, COOKIES[scope], token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax', // Lax, so a link from a cue notification still carries the session; Origin checks block cross-site writes
    path: '/',
    // From the session's own times (just started or renewed), so it matches the store's clock.
    maxAge: Math.floor((Date.parse(session.expiresAt) - Date.parse(session.lastUsedAt)) / 1000),
  });
}

/** The live session for a scope. A terminal session also opens Goals. Renewed Goals cookies are sent again. */
export function currentSession(c: Context, store: AuthStore, scope: SessionScope): Session | null {
  const scopes: SessionScope[] = scope === 'goals' ? ['goals', 'terminal'] : ['terminal'];
  for (const s of scopes) {
    const token = getCookie(c, COOKIES[s]);
    const session = token ? store.verifySession(token) : null;
    if (!session || session.scope !== s) continue;
    if (session.renewed) setSession(c, s, token!, session);
    return session;
  }
  return null;
}

/** Guards a route: 401 without a session for the scope. */
export function requireSession(store: AuthStore, scope: SessionScope): MiddlewareHandler {
  return async (c, next) => {
    if (!currentSession(c, store, scope)) return c.json({ error: 'Sign in first.', signIn: scope }, 401);
    await next();
  };
}

/** Adds /api/auth/*: state, pairing, sign-in and sign-out. */
export function authRoutes(app: Hono, { store, publicUrl, totpSecret, now = Date.now }: AuthOptions): void {
  const rp = publicUrl ? parsePublicUrl(publicUrl) : null;
  /** Challenges handed out and not used yet: single use, 5 minutes. Pairing ones are tied to their pairing. */
  const challenges = new Map<string, { expires: number; pairingId: string | null }>();
  const failures: number[] = [];
  const wrongCodes: number[] = [];

  /** Drops entries older than a minute, then says whether the limit is reached. */
  const full = (list: number[], max: number) => {
    while (list.length && list[0]! <= now() - 60_000) list.shift();
    return list.length >= max;
  };
  const tooMany = () => full(failures, MAX_FAILURES);
  const failed = () => failures.push(now());
  const issue = (challenge: string, pairingId: string | null) => {
    for (const [key, value] of challenges) if (value.expires <= now()) challenges.delete(key);
    challenges.set(challenge, { expires: now() + CHALLENGE_TTL, pairingId });
  };
  /** Checks and uses up a challenge from the client data. */
  const takeChallenge = (pairingId: string | null) => (challenge: string) => {
    const entry = challenges.get(challenge);
    challenges.delete(challenge);
    return Boolean(entry && entry.expires > now() && entry.pairingId === pairingId);
  };
  const noPasskeys = (c: Context) => problem(c, 409, 'Passkeys need a public address.', 'Start keel serve with --public-url https://<your-tunnel-name>');
  const slowDown = (c: Context) => problem(c, 429, 'Too many tries. Wait a minute, then try again.');

  app.get('/api/auth/state', (c) =>
    c.json({
      login: true,
      passkeys: Boolean(rp),
      totp: Boolean(totpSecret && store.totp()),
      // Passkeys only work at this address, so the page can send people there.
      ...(rp ? { origin: rp.origin } : {}),
      signedIn: { goals: Boolean(currentSession(c, store, 'goals')), terminal: Boolean(currentSession(c, store, 'terminal')) },
    }),
  );

  // ---- pairing: the phone opens /pair#<token> from the terminal's QR code ----

  app.post('/api/auth/pair/options', async (c) => {
    if (!rp) return noPasskeys(c);
    if (tooMany()) return slowDown(c);
    const input = await body(c);
    if (!input) return problem(c, 415, 'Expected JSON');
    let pairing;
    try {
      pairing = store.checkPairing(String(input.token ?? ''));
    } catch (e) {
      failed();
      if (e instanceof KeelError) return problem(c, 403, e.message, e.hint);
      throw e;
    }
    if (pairing.rpId !== rp.rpId) return problem(c, 403, `This link was made for ${pairing.rpId}.`, 'Make a new one on your computer: keel auth passkey add');
    const options = await generateRegistrationOptions({
      rpName: 'Keel',
      rpID: rp.rpId,
      userName: 'keel',
      userDisplayName: 'Keel',
      userID: randomBytes(16),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: store.passkeys().filter((p) => p.rpId === rp.rpId).map((p) => ({ id: p.credentialId, transports: p.transports })),
      timeout: CHALLENGE_TTL,
    });
    issue(options.challenge, pairing.id);
    return c.json({ options, name: pairing.name });
  });

  app.post('/api/auth/pair/verify', async (c) => {
    if (!rp) return noPasskeys(c);
    if (tooMany()) return slowDown(c);
    const input = await body(c);
    if (!input) return problem(c, 415, 'Expected JSON');
    const token = String(input.token ?? '');
    try {
      const pairing = store.checkPairing(token);
      const result = await verifyRegistrationResponse({
        response: input.response as RegistrationResponseJSON,
        expectedChallenge: takeChallenge(pairing.id),
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserVerification: true,
      }).catch(() => ({ verified: false as const }));
      if (!result.verified) {
        failed();
        return problem(c, 403, "The phone's passkey could not be checked.", 'Make a new link on your computer and try again: keel auth passkey add');
      }
      const { credential } = result.registrationInfo;
      const passkey = store.completePairing(token, {
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports ?? [],
      });
      const { session, token: cookie } = store.createSession({ passkeyId: passkey.id, method: 'passkey', scope: 'goals' });
      setSession(c, 'goals', cookie, session);
      return c.json({ paired: passkey.name });
    } catch (e) {
      if (!(e instanceof KeelError)) throw e;
      failed();
      return problem(c, 403, e.message, e.hint);
    }
  });

  // ---- sign-in ----

  app.post('/api/auth/signin/options', async (c) => {
    if (!rp) return noPasskeys(c);
    if (tooMany()) return slowDown(c);
    const options = await generateAuthenticationOptions({ rpID: rp.rpId, userVerification: 'required', timeout: CHALLENGE_TTL });
    issue(options.challenge, null);
    return c.json({ options });
  });

  app.post('/api/auth/signin/verify', async (c) => {
    if (!rp) return noPasskeys(c);
    if (tooMany()) return slowDown(c);
    const input = await body(c);
    if (!input) return problem(c, 415, 'Expected JSON');
    const scope = input.scope ?? 'goals';
    if (!isScope(scope)) return problem(c, 400, 'Unknown scope.');
    const response = input.response as AuthenticationResponseJSON | undefined;
    const passkey = typeof response?.id === 'string' ? store.passkeyByCredential(response.id) : null;
    if (!passkey || passkey.rpId !== rp.rpId) {
      failed();
      return problem(c, 401, "This passkey isn't paired with Keel.", 'Pair it from your computer: keel auth passkey add');
    }
    const result = await verifyAuthenticationResponse({
      response: response!,
      expectedChallenge: takeChallenge(null),
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      credential: { id: passkey.credentialId, publicKey: Buffer.from(passkey.publicKey, 'base64url'), counter: passkey.counter, transports: passkey.transports as never },
      requireUserVerification: true,
    }).catch(() => ({ verified: false, authenticationInfo: null }));
    if (!result.verified || !result.authenticationInfo) {
      failed();
      return problem(c, 401, 'Sign-in failed.', 'Try again.');
    }
    store.recordUse(passkey.id, result.authenticationInfo.newCounter);
    const { session, token } = store.createSession({ passkeyId: passkey.id, method: 'passkey', scope });
    setSession(c, scope, token, session);
    return c.json({ signedIn: scope, ends: session.expiresAt });
  });

  // ---- TOTP fallback: a six-digit code, at any address (ADR 0002) ----

  app.post('/api/auth/totp/verify', async (c) => {
    const secret = totpSecret && store.totp() ? await totpSecret() : null;
    if (!secret) return problem(c, 409, "Codes aren't turned on.", 'On your computer: keel auth totp enable');
    if (full(wrongCodes, MAX_WRONG_CODES)) return slowDown(c);
    const input = await body(c);
    if (!input) return problem(c, 415, 'Expected JSON');
    const scope = input.scope ?? 'goals';
    if (!isScope(scope)) return problem(c, 400, 'Unknown scope.');
    const step = checkTotp(secret, String(input.code ?? ''), now());
    if (step === null) {
      wrongCodes.push(now());
      return problem(c, 401, "That code isn't right.", 'Check the time on your phone, then try the next code.');
    }
    if (!store.useTotpStep(step)) return problem(c, 401, 'That code was already used.', 'Wait for the next code.');
    const { session, token } = store.createSession({ passkeyId: null, method: 'totp', scope });
    setSession(c, scope, token, session);
    return c.json({ signedIn: scope, ends: session.expiresAt });
  });

  app.post('/api/auth/signout', async (c) => {
    for (const scope of Object.keys(COOKIES) as SessionScope[]) {
      const token = getCookie(c, COOKIES[scope]);
      const session = token ? store.verifySession(token) : null;
      if (session) store.revokeSession(session.id);
      deleteCookie(c, COOKIES[scope], { path: '/', secure: true });
    }
    return c.json({ signedOut: true });
  });
}

export interface ServeCheck {
  host: string;
  publicUrl?: string;
  cert?: string;
  key?: string;
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|::1)$/;

/**
 * The refusal rules for `keel serve` (ADR 0002). Plain `keel serve` needs no login.
 * `--public-url` turns login on. Binding beyond this machine needs login set up and HTTPS.
 * Returns whether login is required.
 */
export function checkServe({ host, publicUrl, cert, key }: ServeCheck, store: AuthStore): { login: boolean } {
  if (Boolean(cert) !== Boolean(key)) throw new KeelError('--cert and --key go together.', 'Give both files, or neither.');
  if (publicUrl) parsePublicUrl(publicUrl);
  if (LOOPBACK.test(host)) return { login: Boolean(publicUrl) };
  if (!cert && !publicUrl) {
    throw new KeelError(`Keel won't listen on ${host} without HTTPS.`, 'Add --cert and --key, or put it behind an HTTPS tunnel with --public-url https://<your-tunnel-name>');
  }
  if (!store.passkeys().length && !store.totp()) {
    throw new KeelError(
      `Keel won't listen on ${host} before a login is set up.`,
      'Pair your phone first: keel serve --public-url https://<your-tunnel-name> (on this machine), then keel auth passkey add. Or turn on codes: keel auth totp enable',
    );
  }
  return { login: true };
}

