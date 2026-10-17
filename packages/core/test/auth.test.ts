import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthStore, hashToken, parsePublicUrl, PAIRING_TTL, SESSION_TTL } from '../src/auth';

const URL = 'https://keel.example.ts.net';
const credential = (n = 1) => ({ credentialId: `cred-${n}`, publicKey: `key-${n}`, counter: 0, transports: ['internal'] });

let home: string;
let clock: Date;
let store: AuthStore;
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'keel-auth-'));
  clock = new Date('2026-10-17T09:00:00Z');
  store = AuthStore.at(home, () => clock);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Pairs a phone through a fresh link and returns its passkey. */
function pair(name = 'My iPhone', n = 1) {
  const { token } = store.createPairing(name, URL);
  return store.completePairing(token, credential(n));
}

describe('public address', () => {
  it('takes an https hostname and gives its origin and RP ID', () => {
    expect(parsePublicUrl('https://keel.example.ts.net/')).toEqual({ origin: URL, rpId: 'keel.example.ts.net' });
  });

  it('refuses http, IP addresses and paths', () => {
    expect(() => parsePublicUrl('http://keel.example.ts.net')).toThrow('must start with https://');
    expect(() => parsePublicUrl('https://192.168.1.20')).toThrow('need a hostname');
    expect(() => parsePublicUrl('https://keel.example.ts.net/goals')).toThrow('without a path');
    expect(() => parsePublicUrl('keel.example.ts.net')).toThrow("isn't an address");
  });
});

describe('pairing', () => {
  it('puts the token after # and stores only its hash', () => {
    const { token, url, pairing } = store.createPairing('My iPhone', URL);
    expect(url).toBe(`${URL}/pair#${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const file = readFileSync(join(home, 'auth', 'pairings.json'), 'utf8');
    expect(file).not.toContain(token);
    expect(file).toContain(hashToken(token));
    expect(pairing).toMatchObject({ name: 'My iPhone', rpId: 'keel.example.ts.net', origin: URL, passkeyId: null });
  });

  it('adds the passkey with the pairing name and host, and marks the link used', () => {
    const { token, pairing } = store.createPairing('My iPhone', URL);
    const passkey = store.completePairing(token, credential());
    expect(passkey).toMatchObject({ name: 'My iPhone', rpId: 'keel.example.ts.net', credentialId: 'cred-1', lastUsedAt: null });
    expect(store.passkeys()).toHaveLength(1);
    expect(store.pairing(pairing.id)?.passkeyId).toBe(passkey.id);
  });

  it('works only once', () => {
    const { token } = store.createPairing('My iPhone', URL);
    store.completePairing(token, credential(1));
    expect(() => store.checkPairing(token)).toThrow('already used');
    expect(() => store.completePairing(token, credential(2))).toThrow('already used');
    expect(store.passkeys()).toHaveLength(1);
  });

  it('expires after 10 minutes', () => {
    const { token } = store.createPairing('My iPhone', URL);
    advance(PAIRING_TTL - 1000);
    expect(store.checkPairing(token).name).toBe('My iPhone');
    advance(1000);
    expect(() => store.completePairing(token, credential())).toThrow('expired');
  });

  it('refuses an unknown or cancelled link', () => {
    expect(() => store.checkPairing('nope')).toThrow('not valid');
    const { token, pairing } = store.createPairing('My iPhone', URL);
    store.cancelPairing(pairing.id);
    expect(() => store.checkPairing(token)).toThrow('not valid');
  });

  it('refuses the same credential twice', () => {
    pair('One', 1);
    const { token } = store.createPairing('Two', URL);
    expect(() => store.completePairing(token, credential(1))).toThrow('already paired');
  });

  it('drops used and expired links when a new one is made', () => {
    pair('One', 1);
    store.createPairing('Stale', URL);
    advance(PAIRING_TTL);
    store.createPairing('Fresh', URL);
    const names = (JSON.parse(readFileSync(join(home, 'auth', 'pairings.json'), 'utf8')) as Array<{ name: string }>).map((p) => p.name);
    expect(names).toEqual(['Fresh']);
  });
});

describe('passkeys', () => {
  it('are found by id or by name, ignoring case', () => {
    const passkey = pair('My iPhone');
    expect(store.findPasskey(passkey.id).name).toBe('My iPhone');
    expect(store.findPasskey('my iphone').id).toBe(passkey.id);
    expect(() => store.findPasskey('Pixel')).toThrow('No passkey "Pixel"');
  });

  it('asks for the id when two share a name', () => {
    pair('Phone', 1);
    pair('Phone', 2);
    expect(() => store.findPasskey('phone')).toThrow('2 passkeys are called "phone"');
  });

  it('record the counter and when they were last used', () => {
    const passkey = pair();
    advance(60_000);
    store.recordUse(passkey.id, 7);
    expect(store.passkeyByCredential('cred-1')).toMatchObject({ counter: 7, lastUsedAt: clock.toISOString() });
  });

  it('end their sessions when removed', () => {
    const phone = pair('My iPhone', 1);
    const laptop = pair('Laptop', 2);
    const { token } = store.createSession({ passkeyId: phone.id, method: 'passkey', scope: 'goals' });
    store.createSession({ passkeyId: phone.id, method: 'passkey', scope: 'terminal' });
    store.createSession({ passkeyId: laptop.id, method: 'passkey', scope: 'goals' });
    expect(store.removePasskey('my iphone').sessionsEnded).toBe(2);
    expect(store.verifySession(token)).toBeNull();
    expect(store.sessions()).toHaveLength(1);
    expect(store.passkeys().map((p) => p.name)).toEqual(['Laptop']);
  });

  it('are kept in owner-only files', () => {
    mkdirSync(join(home, 'auth'), { mode: 0o755 });
    pair();
    expect(statSync(join(home, 'auth', 'passkeys.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'auth')).mode & 0o777).toBe(0o700);
  });

  it('say so when the file is damaged, instead of acting as if there were none', () => {
    pair();
    writeFileSync(join(home, 'auth', 'passkeys.json'), '{oops');
    expect(() => store.passkeys()).toThrow('is damaged');
  });
});

describe('sessions', () => {
  it('store only the token hash', () => {
    const { token } = store.createSession({ passkeyId: null, method: 'passkey', scope: 'goals' });
    const file = readFileSync(join(home, 'auth', 'sessions.json'), 'utf8');
    expect(file).not.toContain(token);
    expect(file).toContain(hashToken(token));
  });

  it('last 12 hours for the browser terminal', () => {
    const { token } = store.createSession({ passkeyId: pair().id, method: 'passkey', scope: 'terminal' });
    advance(SESSION_TTL.terminal - 1000);
    expect(store.verifySession(token)?.scope).toBe('terminal');
    advance(1000);
    expect(store.verifySession(token)).toBeNull();
  });

  it('last 30 days for Goals, renewed on use', () => {
    const { token, session } = store.createSession({ passkeyId: pair().id, method: 'passkey', scope: 'goals' });
    expect(session.expiresAt).toBe(new Date(clock.getTime() + SESSION_TTL.goals).toISOString());
    advance(20 * 24 * 3600_000);
    expect(store.verifySession(token)?.expiresAt).toBe(new Date(clock.getTime() + SESSION_TTL.goals).toISOString());
    advance(20 * 24 * 3600_000);
    expect(store.verifySession(token)).not.toBeNull();
  });

  it('are not rewritten on every request', () => {
    const { token, session } = store.createSession({ passkeyId: pair().id, method: 'passkey', scope: 'goals' });
    advance(5 * 60_000);
    expect(store.verifySession(token)?.expiresAt).toBe(session.expiresAt);
  });

  it('from a TOTP code last 12 hours, even for Goals, and are not renewed', () => {
    const { token } = store.createSession({ passkeyId: null, method: 'totp', scope: 'goals' });
    advance(2 * 3600_000);
    store.verifySession(token);
    advance(SESSION_TTL.terminal - 2 * 3600_000);
    expect(store.verifySession(token)).toBeNull();
  });

  it('can be ended one at a time or all at once', () => {
    const a = store.createSession({ passkeyId: null, method: 'passkey', scope: 'goals' });
    const b = store.createSession({ passkeyId: null, method: 'passkey', scope: 'terminal' });
    store.revokeSession(a.session.id);
    expect(store.verifySession(a.token)).toBeNull();
    expect(store.verifySession(b.token)).not.toBeNull();
    expect(() => store.revokeSession('nope')).toThrow('No session "nope"');
    expect(store.revokeAllSessions()).toBe(1);
    expect(store.sessions()).toEqual([]);
  });

  it('refuse a wrong token', () => {
    store.createSession({ passkeyId: null, method: 'passkey', scope: 'goals' });
    expect(store.verifySession('not-a-token')).toBeNull();
  });
});

describe('the running server', () => {
  it('is found while its process runs', () => {
    store.writeServerInfo({ publicUrl: URL, port: 4242, pid: process.pid });
    expect(store.serverInfo()).toMatchObject({ publicUrl: URL, port: 4242, pid: process.pid });
    store.clearServerInfo(process.pid + 1);
    expect(store.serverInfo()).not.toBeNull();
    store.clearServerInfo(process.pid);
    expect(store.serverInfo()).toBeNull();
  });

  it('is forgotten when the process that wrote it is gone', () => {
    store.writeServerInfo({ publicUrl: URL, port: 4242, pid: 2 ** 22 + 12345 });
    expect(store.serverInfo()).toBeNull();
  });
});
