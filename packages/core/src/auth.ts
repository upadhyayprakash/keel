import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeelError } from './errors';

// ADR 0002: passkey login for `keel serve --public-url`. Everything lives in
// ~/.keel/auth/, per machine and never synced: a passkey belongs to one server's
// hostname. Tokens (pairing and session) are stored only as SHA-256 hashes.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A pairing link works once, for 10 minutes. */
export const PAIRING_TTL = 10 * MINUTE;
/** Goals sessions last 30 days and renew on use; terminal and TOTP sessions last 12 hours. */
export const SESSION_TTL = { goals: 30 * DAY, terminal: 12 * HOUR } as const;
/** A Goals session is renewed at most this often, so not every request writes the file. */
const RENEW_EVERY = HOUR;

export type SessionScope = keyof typeof SESSION_TTL;
export type SignInMethod = 'passkey' | 'totp';

export interface Passkey {
  /** Short id for `keel auth passkey remove`. */
  id: string;
  name: string;
  /** WebAuthn credential ID and COSE public key, base64url. */
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  /** The hostname the passkey was made for (the relying party ID). */
  rpId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type NewPasskey = Pick<Passkey, 'credentialId' | 'publicKey' | 'counter' | 'transports'>;

export interface Pairing {
  id: string;
  tokenHash: string;
  /** The name the new passkey gets. */
  name: string;
  /** `https://<name>` from --public-url, and its hostname. */
  origin: string;
  rpId: string;
  createdAt: string;
  expiresAt: string;
  /** Set once a phone has used the link. */
  passkeyId: string | null;
}

export interface Session {
  id: string;
  tokenHash: string;
  /** The passkey that signed in, or null for TOTP. */
  passkeyId: string | null;
  method: SignInMethod;
  scope: SessionScope;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
}

/** Written by `keel serve --public-url` while it runs, so `keel auth passkey add` can find it. */
export interface ServerInfo {
  publicUrl: string;
  port: number;
  pid: number;
  startedAt: string;
}

/** TOTP is on when this exists. The secret itself is in the secret store, never here. */
export interface TotpState {
  enabledAt: string;
  /** The last time step a code was accepted for; that step and earlier ones are refused (no replay). */
  lastStep: number;
}

const FILES = { passkeys: 'passkeys.json', pairings: 'pairings.json', sessions: 'sessions.json', server: 'server.json', totp: 'totp.json' };

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const newId = (taken: Set<string>): string => {
  for (;;) {
    const id = randomBytes(3).toString('hex');
    if (!taken.has(id)) return id;
  }
};

/** Checks a --public-url value: https, a real hostname, no path. Returns its origin and hostname. */
export function parsePublicUrl(value: string): { origin: string; rpId: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new KeelError(`"${value}" isn't an address.`, 'It looks like https://keel.example.ts.net');
  }
  if (url.protocol !== 'https:') throw new KeelError('The public address must start with https://', 'Passkeys only work over HTTPS.');
  if (/^[\d.]+$|^\[/.test(url.hostname)) throw new KeelError('Passkeys need a hostname, not an IP address.', 'Use your tunnel name, like https://keel.example.ts.net');
  if (url.pathname !== '/' || url.search || url.hash) throw new KeelError('Give the address without a path.', `Use ${url.origin}`);
  return { origin: url.origin, rpId: url.hostname };
}

/** Is a process with this id still running? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class AuthStore {
  constructor(
    readonly dir: string,
    private now: () => Date = () => new Date(),
  ) {}

  /** `~/.keel/auth` for Keel's folder. */
  static at(home: string, now?: () => Date): AuthStore {
    return new AuthStore(join(home, 'auth'), now);
  }

  // ---- files ----

  private read<T>(name: string, fallback: T): T {
    const file = join(this.dir, name);
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;
    } catch {
      throw new KeelError(`${file} is damaged.`, 'Fix or delete it. Deleting passkeys.json means pairing your phone again.');
    }
  }

  /** Owner-only, and written to a side file first so a crash never leaves half a file. */
  private write(name: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700); // mkdir's mode only applies to a new folder
    const file = join(this.dir, name);
    const partial = `${file}.partial`;
    writeFileSync(partial, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(partial, file);
  }

  private iso(offset = 0): string {
    return new Date(this.now().getTime() + offset).toISOString();
  }

  private expired(at: string): boolean {
    return Date.parse(at) <= this.now().getTime();
  }

  // ---- passkeys ----

  passkeys(): Passkey[] {
    return this.read<Passkey[]>(FILES.passkeys, []);
  }

  /** By id, or by name ignoring case. */
  findPasskey(ref: string): Passkey {
    const all = this.passkeys();
    const byId = all.find((p) => p.id === ref);
    if (byId) return byId;
    const byName = all.filter((p) => p.name.toLowerCase() === ref.toLowerCase());
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) throw new KeelError(`${byName.length} passkeys are called "${ref}".`, 'Use the id instead: keel auth passkey list');
    throw new KeelError(`No passkey "${ref}".`, 'See them with: keel auth passkey list');
  }

  passkeyByCredential(credentialId: string): Passkey | null {
    return this.passkeys().find((p) => p.credentialId === credentialId) ?? null;
  }

  /** After a sign-in: the authenticator's new counter and the time. */
  recordUse(id: string, counter: number): void {
    this.write(
      FILES.passkeys,
      this.passkeys().map((p) => (p.id === id ? { ...p, counter, lastUsedAt: this.iso() } : p)),
    );
  }

  /** Deletes a passkey and ends every session it started. */
  removePasskey(ref: string): { passkey: Passkey; sessionsEnded: number } {
    const passkey = this.findPasskey(ref);
    this.write(
      FILES.passkeys,
      this.passkeys().filter((p) => p.id !== passkey.id),
    );
    const sessions = this.read<Session[]>(FILES.sessions, []);
    const kept = sessions.filter((s) => s.passkeyId !== passkey.id);
    this.write(FILES.sessions, kept);
    return { passkey, sessionsEnded: sessions.length - kept.length };
  }

  // ---- pairing ----

  /** A one-time link for a phone to add a passkey. The token is returned once and stored as a hash. */
  createPairing(name: string, publicUrl: string): { pairing: Pairing; token: string; url: string } {
    const { origin, rpId } = parsePublicUrl(publicUrl);
    const pairings = this.livePairings();
    const token = newToken();
    const pairing: Pairing = {
      id: newId(new Set(pairings.map((p) => p.id))),
      tokenHash: hashToken(token),
      name,
      origin,
      rpId,
      createdAt: this.iso(),
      expiresAt: this.iso(PAIRING_TTL),
      passkeyId: null,
    };
    this.write(FILES.pairings, [...pairings, pairing]);
    // After `#`, so the token never reaches server logs or the tunnel's request records.
    return { pairing, token, url: `${origin}/pair#${token}` };
  }

  pairing(id: string): Pairing | null {
    return this.read<Pairing[]>(FILES.pairings, []).find((p) => p.id === id) ?? null;
  }

  /** The pairing a token opens, if it is unused and not expired. */
  checkPairing(token: string): Pairing {
    const pairing = this.read<Pairing[]>(FILES.pairings, []).find((p) => p.tokenHash === hashToken(token));
    if (!pairing) throw new KeelError('This pairing link is not valid.', 'Make a new one on your computer: keel auth passkey add');
    if (pairing.passkeyId) throw new KeelError('This pairing link was already used.', 'Make a new one on your computer: keel auth passkey add');
    if (this.expired(pairing.expiresAt)) throw new KeelError('This pairing link has expired.', 'Make a new one on your computer: keel auth passkey add');
    return pairing;
  }

  /** Uses the link: stores the new passkey and marks the pairing done, so it can't be used again. */
  completePairing(token: string, credential: NewPasskey): Passkey {
    const pairing = this.checkPairing(token);
    const all = this.passkeys();
    if (all.some((p) => p.credentialId === credential.credentialId)) throw new KeelError('This passkey is already paired.');
    const passkey: Passkey = {
      ...credential,
      id: newId(new Set(all.map((p) => p.id))),
      name: pairing.name,
      rpId: pairing.rpId,
      createdAt: this.iso(),
      lastUsedAt: null,
    };
    this.write(FILES.passkeys, [...all, passkey]);
    this.write(
      FILES.pairings,
      this.read<Pairing[]>(FILES.pairings, []).map((p) => (p.id === pairing.id ? { ...p, passkeyId: passkey.id } : p)),
    );
    return passkey;
  }

  /** The terminal gave up waiting (Ctrl+C): the link stops working. */
  cancelPairing(id: string): void {
    this.write(
      FILES.pairings,
      this.read<Pairing[]>(FILES.pairings, []).filter((p) => p.id !== id),
    );
  }

  /** Unused and unexpired pairings; the rest are dropped when the file is next written. */
  private livePairings(): Pairing[] {
    return this.read<Pairing[]>(FILES.pairings, []).filter((p) => !p.passkeyId && !this.expired(p.expiresAt));
  }

  // ---- sessions ----

  /** Sessions that have not expired. */
  sessions(): Session[] {
    return this.read<Session[]>(FILES.sessions, []).filter((s) => !this.expired(s.expiresAt));
  }

  /** Starts a session; the token goes in the cookie and is returned only here. TOTP sessions last 12 hours. */
  createSession(input: { passkeyId: string | null; method: SignInMethod; scope: SessionScope }): { session: Session; token: string } {
    const live = this.sessions();
    const token = newToken();
    const ttl = input.method === 'totp' ? SESSION_TTL.terminal : SESSION_TTL[input.scope];
    const session: Session = {
      ...input,
      id: newId(new Set(live.map((s) => s.id))),
      tokenHash: hashToken(token),
      createdAt: this.iso(),
      expiresAt: this.iso(ttl),
      lastUsedAt: this.iso(),
    };
    this.write(FILES.sessions, [...live, session]);
    return { session, token };
  }

  /** The live session for a cookie token, or null. A Goals passkey session is renewed for another 30 days (`renewed`, so the cookie can be sent again). */
  verifySession(token: string): (Session & { renewed?: true }) | null {
    const session = this.sessions().find((s) => s.tokenHash === hashToken(token));
    if (!session) return null;
    const renews = session.scope === 'goals' && session.method === 'passkey';
    if (!renews || this.now().getTime() - Date.parse(session.lastUsedAt) < RENEW_EVERY) return session;
    const renewed = { ...session, lastUsedAt: this.iso(), expiresAt: this.iso(SESSION_TTL.goals) };
    this.write(
      FILES.sessions,
      this.sessions().map((s) => (s.id === session.id ? renewed : s)),
    );
    return { ...renewed, renewed: true };
  }

  revokeSession(id: string): Session {
    const live = this.sessions();
    const session = live.find((s) => s.id === id);
    if (!session) throw new KeelError(`No session "${id}".`, 'See them with: keel auth sessions');
    this.write(
      FILES.sessions,
      live.filter((s) => s.id !== id),
    );
    return session;
  }

  /** Ends every session. Returns how many were live. */
  revokeAllSessions(): number {
    const count = this.sessions().length;
    this.write(FILES.sessions, []);
    return count;
  }

  // ---- TOTP ----

  totp(): TotpState | null {
    return this.read<TotpState | null>(FILES.totp, null);
  }

  /** After the confirming code; that code's step counts as used. */
  enableTotp(step: number): void {
    this.write(FILES.totp, { enabledAt: this.iso(), lastStep: step } satisfies TotpState);
  }

  /** Turns TOTP off and ends every session a code started. Returns how many. */
  disableTotp(): number {
    rmSync(join(this.dir, FILES.totp), { force: true });
    const sessions = this.read<Session[]>(FILES.sessions, []);
    const kept = sessions.filter((s) => s.method !== 'totp');
    if (kept.length !== sessions.length) this.write(FILES.sessions, kept);
    return sessions.length - kept.length;
  }

  /** Marks a code's step as used. False when it, or a later one, was used already. */
  useTotpStep(step: number): boolean {
    const state = this.totp();
    if (!state || step <= state.lastStep) return false;
    this.write(FILES.totp, { ...state, lastStep: step });
    return true;
  }

  // ---- the running server ----

  writeServerInfo(info: Omit<ServerInfo, 'startedAt'>): void {
    this.write(FILES.server, { ...info, startedAt: this.iso() } satisfies ServerInfo);
  }

  /** The running `keel serve --public-url`, or null. A file left by a server that crashed is removed. */
  serverInfo(): ServerInfo | null {
    const info = this.read<ServerInfo | null>(FILES.server, null);
    if (!info) return null;
    if (alive(info.pid)) return info;
    rmSync(join(this.dir, FILES.server), { force: true });
    return null;
  }

  /** On exit. Only the server that wrote the file removes it. */
  clearServerInfo(pid: number): void {
    const info = this.read<ServerInfo | null>(FILES.server, null);
    if (info?.pid === pid) rmSync(join(this.dir, FILES.server), { force: true });
  }
}
