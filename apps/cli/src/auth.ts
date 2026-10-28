import { hostname } from 'node:os';
import { AuthStore, KeelError, PAIRING_TTL, checkTotp, fail, hint, newTotpSecret, ok, s, table, totpUri, warn, type Block, type Paint, type Passkey, type Session } from '@keel/core';
import { renderUnicodeCompact } from 'uqr';
import type { SecretStore } from './secrets';

// ADR 0002: phones are paired, listed and removed here, in the owner's terminal,
// never from the browser. Sessions can be listed and ended here too, and the
// TOTP fallback turned on and off.

/** The secret store entry for the TOTP secret. `keel serve` reads it from there. */
export const TOTP_ACCOUNT = 'auth-totp';
/** What the Keychain or keyring shows for it. */
export const TOTP_LABEL = 'Keel sign-in code key';

interface Io {
  paint: Paint;
  print(blocks: Block[]): void;
  /** Raw text, for the QR code. */
  write(text: string): void;
  /** A line of input; '' when there is no terminal. */
  ask?(prompt: string): Promise<string>;
}

export interface WaitOptions {
  /** How often to look for the phone, in ms. */
  every?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Resolves when the user gives up (Ctrl+C). */
  cancelled?: Promise<void>;
}

export interface CommandOptions extends WaitOptions {
  /** Where the TOTP secret goes. */
  secrets?: SecretStore;
  /** The default name the authenticator app shows, when there is no --label. Defaults to this computer's name. */
  account?: string;
  now?: () => number;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Local date and time, like "2026-10-17 14:05". */
export function when(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const header = (labels: string[]) => labels.map((label) => s(label, 'muted'));

function passkeyRows(passkeys: Passkey[]): Block {
  return table([
    header(['id', 'name', 'for', 'added', 'last used']),
    ...passkeys.map((p) => [s(p.id, 'accent'), s(p.name, 'default', { bold: true }), s(p.rpId), s(when(p.createdAt), 'muted'), s(when(p.lastUsedAt), 'muted')]),
  ]);
}

function sessionRows(sessions: Session[], passkeys: Passkey[]): Block {
  const name = (s: Session) => (s.passkeyId ? (passkeys.find((p) => p.id === s.passkeyId)?.name ?? s.passkeyId) : 'TOTP code');
  return table([
    header(['id', 'signed in with', 'for', 'started', 'ends']),
    ...sessions.map((x) => [s(x.id, 'accent'), s(name(x)), s(x.scope === 'goals' ? 'Goals' : 'browser terminal'), s(when(x.createdAt), 'muted'), s(when(x.expiresAt), 'muted')]),
  ]);
}

/** Pulls `--name <value>` out of the arguments. */
function option(args: string[], flag: string, example = `keel auth passkey add ${flag} "My iPhone"`): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--') || !value.trim()) throw new KeelError(`${flag} needs a value.`, `Example: ${example}`);
  return value;
}

export function authStatus(store: AuthStore, io: Io): number {
  const passkeys = store.passkeys();
  const sessions = store.sessions();
  const server = store.serverInfo();
  const line = (label: string, value: string) => ({ kind: 'line', spans: [s(label.padEnd(10), 'muted'), s(value)] }) as Block;
  const hosts = [...new Set(passkeys.map((p) => p.rpId))];
  io.print([
    line('Passkeys', passkeys.length ? `${passkeys.length} (for ${hosts.join(', ')})` : 'none'),
    line('Codes', store.totp() ? 'on (keel auth totp disable turns them off)' : 'off'),
    line('Sessions', String(sessions.length)),
    line('Server', server ? `keel serve at ${server.publicUrl}` : 'keel serve is not running with a public address'),
    ...(passkeys.length ? [] : [hint(server ? 'Pair your phone: keel auth passkey add' : 'Pair your phone: start keel serve --public-url https://<your-tunnel-name>, then keel auth passkey add')]),
  ]);
  return 0;
}

export function passkeyList(store: AuthStore, io: Io): number {
  const passkeys = store.passkeys();
  if (!passkeys.length) {
    io.print([warn('No passkeys yet.'), hint('Pair your phone: keel auth passkey add')]);
    return 0;
  }
  io.print([passkeyRows(passkeys)]);
  return 0;
}

export function passkeyRemove(store: AuthStore, ref: string | undefined, io: Io): number {
  if (!ref) throw new KeelError('Which passkey?', 'See them with: keel auth passkey list');
  const { passkey, sessionsEnded } = store.removePasskey(ref);
  io.print([
    ok([s('Removed '), s(passkey.name, 'default', { bold: true })]),
    hint(sessionsEnded ? `Ended ${sessionsEnded} session${sessionsEnded === 1 ? '' : 's'} it had started.` : 'It had no open sessions.'),
    hint('Pair a new phone with: keel auth passkey add'),
  ]);
  return 0;
}

/**
 * Prints a one-time QR code for the running `keel serve --public-url`, then waits
 * until a phone uses it, the link expires, or the user presses Ctrl+C.
 */
export async function passkeyAdd(store: AuthStore, args: string[], io: Io, wait: WaitOptions = {}): Promise<number> {
  const server = store.serverInfo();
  if (!server) {
    throw new KeelError("keel serve isn't running with a public address.", 'In another terminal: keel serve --public-url https://<your-tunnel-name>');
  }
  const name = option(args, '--name') ?? `Phone ${store.passkeys().length + 1}`;
  const { pairing, url } = store.createPairing(name, server.publicUrl);

  const others = [...new Set(store.passkeys().map((p) => p.rpId))].filter((host) => host !== pairing.rpId);
  if (others.length) io.print([warn(`Your other passkeys are for ${others.join(', ')}. They don't work at ${pairing.rpId}.`)]);

  io.print([ok([s('Scan this with your phone to add '), s(name, 'default', { bold: true })])]);
  io.write(renderUnicodeCompact(url, { border: 2 }));
  io.print([hint(`Or open: ${url}`), hint(`Works once, for ${PAIRING_TTL / 60_000} minutes. Waiting for your phone (Ctrl+C to stop)...`)]);

  const every = wait.every ?? 1000;
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let stopped = false;
  void wait.cancelled?.then(() => (stopped = true));
  const deadline = Date.parse(pairing.expiresAt);

  for (;;) {
    const current = store.pairing(pairing.id);
    if (current?.passkeyId) {
      io.print([ok([s('Paired: '), s(name, 'default', { bold: true })]), hint('Your phone is signed in. Add the app to its home screen to stay signed in.')]);
      return 0;
    }
    if (stopped) {
      store.cancelPairing(pairing.id);
      io.print([warn('Stopped. That link no longer works.')]);
      return 1;
    }
    if (!current || Date.now() >= deadline) {
      store.cancelPairing(pairing.id);
      io.print([fail('The link expired before a phone used it.'), hint('Run keel auth passkey add again.')]);
      return 1;
    }
    await Promise.race([sleep(every), wait.cancelled ?? new Promise(() => {})]);
  }
}

/** Shows a QR code for the authenticator app, and turns codes on once a code from it checks out. */
export async function totpEnable(store: AuthStore, args: string[], io: Io, options: CommandOptions): Promise<number> {
  if (store.totp()) throw new KeelError('Codes are already on.', 'To start over: keel auth totp disable, then keel auth totp enable');
  const { secrets } = options;
  if (!secrets || !io.ask) throw new KeelError('Turning codes on needs a terminal.');
  const now = options.now ?? Date.now;
  // The name the app shows. It is in the QR code, so --label keeps the computer's name out of screenshots.
  const label = option(args, '--label', 'keel auth totp enable --label "Keel"')?.trim() ?? options.account ?? hostname();
  const secret = newTotpSecret();
  io.print([ok('Scan this with your authenticator app (1Password, Google Authenticator, Authy...)')]);
  io.write(renderUnicodeCompact(totpUri(secret, label), { border: 2 }));
  io.print([hint(`Or type this key: ${secret.match(/.{1,4}/g)!.join(' ')}`), hint('Time-based, 6 digits, every 30 seconds.'), hint(`The app lists it as Keel (${label}).`)]);

  for (let tries = 0; tries < 3; tries++) {
    const code = (await io.ask('Code from the app:')).trim();
    if (!code) break;
    const step = checkTotp(secret, code, now());
    if (step === null) {
      io.print([warn("That code isn't right. Check the app shows Keel, then try the next code.")]);
      continue;
    }
    try {
      await secrets.set(TOTP_ACCOUNT, secret, TOTP_LABEL);
    } catch (e) {
      throw new KeelError(`Couldn't save the key in ${secrets.label}, so codes are still off.`, e instanceof Error ? e.message : undefined);
    }
    store.enableTotp(step);
    io.print([
      ok('Codes are on.'),
      hint('The sign-in page now offers "Use a code instead". A code sign-in lasts 12 hours.'),
      hint(`The key is in ${secrets.label}. There are no recovery codes: this terminal is the way back in.`),
    ]);
    return 0;
  }
  io.print([fail('Codes are still off.'), hint('Run keel auth totp enable again.')]);
  return 1;
}

export async function totpDisable(store: AuthStore, io: Io, options: CommandOptions): Promise<number> {
  if (!store.totp()) {
    io.print([warn('Codes are already off.')]);
    return 0;
  }
  await options.secrets?.delete(TOTP_ACCOUNT);
  const ended = store.disableTotp();
  io.print([ok('Codes are off.'), hint(ended ? `Ended ${ended} session${ended === 1 ? '' : 's'} a code had started.` : 'No code sessions were open.')]);
  return 0;
}

export function sessionsCommand(store: AuthStore, args: string[], io: Io): number {
  if (args[0] === 'revoke') {
    if (args[1] === '--all') {
      const count = store.revokeAllSessions();
      io.print([ok(count ? `Ended ${count} session${count === 1 ? '' : 's'}.` : 'There were no open sessions.')]);
      return 0;
    }
    if (!args[1]) throw new KeelError('Which session?', 'keel auth sessions revoke <id>, or --all');
    const session = store.revokeSession(args[1]);
    io.print([ok(`Ended session ${session.id}.`)]);
    return 0;
  }
  if (args[0]) throw new KeelError(`Unknown "auth sessions ${args[0]}".`, 'Try: keel auth sessions, keel auth sessions revoke <id>|--all');
  const sessions = store.sessions();
  if (!sessions.length) {
    io.print([warn('No open sessions.')]);
    return 0;
  }
  io.print([sessionRows(sessions, store.passkeys())]);
  return 0;
}

/** `keel auth ...` */
export async function authCommand(store: AuthStore, args: string[], io: Io, options: CommandOptions = {}): Promise<number> {
  const [group, action, ...rest] = args;
  if (!group || group === 'status') return authStatus(store, io);
  if (group === 'sessions') return sessionsCommand(store, [action, ...rest].filter((a): a is string => a !== undefined), io);
  if (group === 'passkey') {
    if (!action || action === 'list') return passkeyList(store, io);
    if (action === 'add') return passkeyAdd(store, rest, io, options);
    if (action === 'remove') return passkeyRemove(store, rest[0], io);
    throw new KeelError(`Unknown "auth passkey ${action}".`, 'Try: keel auth passkey add, list, remove <name or id>');
  }
  if (group === 'totp') {
    if (action === 'enable') return totpEnable(store, rest, io, options);
    if (action === 'disable') return totpDisable(store, io, options);
    throw new KeelError(`Unknown "auth totp${action ? ` ${action}` : ''}".`, 'Try: keel auth totp enable, keel auth totp disable');
  }
  throw new KeelError(`Unknown "auth ${group}".`, 'Try: keel auth, keel auth passkey add|list|remove, keel auth totp enable [--label <name>]|disable, keel auth sessions');
}
