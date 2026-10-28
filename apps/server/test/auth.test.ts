import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthStore, Keel, newTotpSecret, totpCode, totpStep } from '@keel/core';
import { checkServe, createApp } from '../src/index';
import { SoftAuthenticator } from './authenticator';

const PUBLIC = 'https://keel.example.ts.net';
const HOST = { host: 'keel.example.ts.net', origin: PUBLIC };
let keel: Keel;
let home: string;
let store: AuthStore;
let app: ReturnType<typeof createApp>;
let phone: SoftAuthenticator;

beforeEach(async () => {
  keel = await Keel.open({ url: ':memory:' });
  home = mkdtempSync(join(tmpdir(), 'keel-serve-auth-'));
  const dist = mkdtempSync(join(home, 'web-'));
  writeFileSync(join(dist, 'index.html'), '<title>keel</title>');
  store = AuthStore.at(home);
  app = createApp({ keel, port: 4242, webDist: dist, auth: { store, publicUrl: PUBLIC } });
  phone = new SoftAuthenticator(PUBLIC, 'keel.example.ts.net');
});
afterEach(() => {
  keel.close();
  rmSync(home, { recursive: true, force: true });
});

/** A tiny cookie jar: keeps what the server sets, sends it back. */
function client(headers: Record<string, string> = HOST) {
  const jar = new Map<string, string>();
  const request = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...headers,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, value] = pair!.split('=');
      if (value) jar.set(name!, value);
      else jar.delete(name!);
    }
    return res;
  };
  return { request, jar };
}

type Options = { options: { challenge: string; rp?: { id: string }; authenticatorSelection?: unknown } };

/** Pairs the soft phone through a fresh link; returns its client, signed in to Goals. */
async function pairPhone(browser = client()) {
  const { token } = store.createPairing('My iPhone', PUBLIC);
  const { options } = (await (await browser.request('/api/auth/pair/options', { body: { token } })).json()) as Options;
  const res = await browser.request('/api/auth/pair/verify', { body: { token, response: phone.register(options) } });
  expect(res.status).toBe(200);
  return browser;
}

async function signIn(browser: ReturnType<typeof client>, scope: 'goals' | 'terminal', tamper = {}) {
  const { options } = (await (await browser.request('/api/auth/signin/options', { body: {} })).json()) as Options;
  return browser.request('/api/auth/signin/verify', { body: { scope, response: phone.signIn(options, tamper) } });
}

const maxAge = (cookie: string) => Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
const runToday = (browser: ReturnType<typeof client>) => browser.request('/api/run', { body: { line: 'today' } });

describe('with login on', () => {
  it('needs a session on every API call, even from this machine', async () => {
    expect((await runToday(client())).status).toBe(401);
    expect((await client({ host: '127.0.0.1:4242' }).request('/api/state')).status).toBe(401);
    const res = await client().request('/api/complete?line=to');
    expect(await res.json()).toEqual({ error: 'Sign in first.', signIn: 'terminal' });
  });

  it('still serves the page, so the sign-in screen can load', async () => {
    expect(await (await client().request('/')).text()).toContain('<title>keel</title>');
  });

  it('accepts the public hostname and refuses others', async () => {
    expect((await client({ host: 'evil.example' }).request('/api/auth/state')).status).toBe(403);
    expect((await client({ ...HOST, origin: 'https://evil.example' }).request('/api/auth/state')).status).toBe(403);
    expect(await (await client().request('/api/auth/state')).json()).toEqual({ login: true, passkeys: true, totp: false, origin: PUBLIC, signedIn: { goals: false, terminal: false } });
  });
});

describe('goals API with login on', () => {
  it('needs a Goals session, and a Goals session reaches only the Goals routes', async () => {
    expect(await (await client().request('/api/goals')).json()).toEqual({ error: 'Sign in first.', signIn: 'goals' });
    expect((await client().request('/api/goals/g1')).status).toBe(401);
    const browser = await pairPhone();
    const list = await browser.request('/api/goals');
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ goals: [] });
    expect((await browser.request('/api/goals/g1')).status).toBe(404);
    expect((await runToday(browser)).status).toBe(401);
  });
});

describe('pairing', () => {
  it('adds the passkey and signs the phone in to Goals, not the terminal', async () => {
    const browser = await pairPhone();
    expect(store.passkeys()).toMatchObject([{ name: 'My iPhone', rpId: 'keel.example.ts.net', credentialId: phone.id }]);
    expect([...browser.jar.keys()]).toEqual(['keel_goals']);
    expect(await (await browser.request('/api/auth/state')).json()).toMatchObject({ signedIn: { goals: true, terminal: false } });
    expect((await runToday(browser)).status).toBe(401);
  });

  it('sets a secure, HttpOnly, Lax cookie for 30 days', async () => {
    const { token } = store.createPairing('My iPhone', PUBLIC);
    const browser = client();
    const { options } = (await (await browser.request('/api/auth/pair/options', { body: { token } })).json()) as Options;
    expect(options.rp?.id).toBe('keel.example.ts.net');
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    const res = await browser.request('/api/auth/pair/verify', { body: { token, response: phone.register(options) } });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^keel_goals=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(maxAge(cookie)).toBeGreaterThanOrEqual(30 * 24 * 3600 - 2);
    expect(maxAge(cookie)).toBeLessThanOrEqual(30 * 24 * 3600);
  });

  it('works once', async () => {
    const { token } = store.createPairing('My iPhone', PUBLIC);
    const browser = client();
    const { options } = (await (await browser.request('/api/auth/pair/options', { body: { token } })).json()) as Options;
    await browser.request('/api/auth/pair/verify', { body: { token, response: phone.register(options) } });
    const again = await browser.request('/api/auth/pair/options', { body: { token } });
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ error: 'This pairing link was already used.' });
  });

  it('refuses a made-up token', async () => {
    const res = await client().request('/api/auth/pair/options', { body: { token: 'guess' } });
    expect(res.status).toBe(403);
  });

  it('refuses a passkey made for another origin or hostname, or without Face ID', async () => {
    for (const tamper of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { noUv: true }]) {
      const { token } = store.createPairing('My iPhone', PUBLIC);
      const browser = client();
      const { options } = (await (await browser.request('/api/auth/pair/options', { body: { token } })).json()) as Options;
      const res = await browser.request('/api/auth/pair/verify', { body: { token, response: phone.register(options, tamper) } });
      expect(res.status).toBe(403);
    }
    expect(store.passkeys()).toEqual([]);
  });

  it('refuses a challenge from another pairing link', async () => {
    const first = store.createPairing('One', PUBLIC);
    const second = store.createPairing('Two', PUBLIC);
    const browser = client();
    const { options } = (await (await browser.request('/api/auth/pair/options', { body: { token: first.token } })).json()) as Options;
    const res = await browser.request('/api/auth/pair/verify', { body: { token: second.token, response: phone.register(options) } });
    expect(res.status).toBe(403);
  });
});

describe('signing in', () => {
  it('opens the browser terminal for 12 hours with its own cookie', async () => {
    const browser = await pairPhone();
    const res = await signIn(browser, 'terminal');
    expect(res.status).toBe(200);
    expect(maxAge(res.headers.get('set-cookie')!)).toBeGreaterThanOrEqual(12 * 3600 - 2);
    expect(maxAge(res.headers.get('set-cookie')!)).toBeLessThanOrEqual(12 * 3600);
    expect([...browser.jar.keys()].sort()).toEqual(['keel_goals', 'keel_terminal']);
    expect((await runToday(browser)).status).toBe(200);
    expect(store.passkeys()[0]).toMatchObject({ counter: 1 });
    expect(store.passkeys()[0]!.lastUsedAt).not.toBeNull();
  });

  it('works on a new browser with no username, from the passkey alone', async () => {
    await pairPhone();
    const fresh = client();
    expect((await signIn(fresh, 'goals')).status).toBe(200);
    expect(await (await fresh.request('/api/auth/state')).json()).toMatchObject({ signedIn: { goals: true, terminal: false } });
  });

  it('refuses the wrong origin or hostname, a missing Face ID, and a reused challenge', async () => {
    const browser = await pairPhone();
    expect((await signIn(browser, 'terminal', { origin: 'https://evil.example' })).status).toBe(401);
    expect((await signIn(browser, 'terminal', { rpId: 'evil.example' })).status).toBe(401);
    expect((await signIn(browser, 'terminal', { noUv: true })).status).toBe(401);

    const { options } = (await (await browser.request('/api/auth/signin/options', { body: {} })).json()) as Options;
    expect((await browser.request('/api/auth/signin/verify', { body: { scope: 'terminal', response: phone.signIn(options) } })).status).toBe(200);
    expect((await browser.request('/api/auth/signin/verify', { body: { scope: 'terminal', response: phone.signIn(options) } })).status).toBe(401);
  });

  it('refuses a passkey that was never paired, or was removed', async () => {
    await pairPhone();
    const stranger = new SoftAuthenticator(PUBLIC, 'keel.example.ts.net');
    const browser = client();
    const { options } = (await (await browser.request('/api/auth/signin/options', { body: {} })).json()) as Options;
    const res = await browser.request('/api/auth/signin/verify', { body: { scope: 'goals', response: stranger.signIn(options) } });
    expect(await res.json()).toMatchObject({ error: "This passkey isn't paired with Keel." });

    store.removePasskey('My iPhone');
    expect((await signIn(client(), 'goals')).status).toBe(401);
  });

  it('ends a session when its passkey is removed', async () => {
    const browser = await pairPhone();
    await signIn(browser, 'terminal');
    store.removePasskey('My iPhone');
    expect((await runToday(browser)).status).toBe(401);
  });

  it('slows down after ten failures in a minute', async () => {
    for (let i = 0; i < 10; i++) await client().request('/api/auth/pair/options', { body: { token: `guess-${i}` } });
    expect((await client().request('/api/auth/signin/options', { body: {} })).status).toBe(429);
  });

  it('signs out of both scopes', async () => {
    const browser = await pairPhone();
    await signIn(browser, 'terminal');
    await browser.request('/api/auth/signout', { body: {} });
    expect(browser.jar.size).toBe(0);
    expect(store.sessions()).toEqual([]);
  });
});

describe('session expiry', () => {
  it('signs the terminal out after 12 hours and keeps Goals for 30 days of use', async () => {
    let clock = Date.now();
    const timed = AuthStore.at(home, () => new Date(clock));
    store = timed;
    app = createApp({ keel, port: 4242, auth: { store: timed, publicUrl: PUBLIC } });
    const browser = await pairPhone();
    await signIn(browser, 'terminal');
    expect((await runToday(browser)).status).toBe(200);
    clock += 12 * 3600_000;
    expect((await runToday(browser)).status).toBe(401);
    expect(await (await browser.request('/api/auth/state')).json()).toMatchObject({ signedIn: { goals: true, terminal: false } });
    clock += 29 * 24 * 3600_000;
    expect(await (await browser.request('/api/auth/state')).json()).toMatchObject({ signedIn: { goals: true } });
  });
});

describe('without login', () => {
  it('says so, so the browser terminal opens straight away', async () => {
    const plain = createApp({ keel, port: 4242 });
    const res = await plain.request('/api/auth/state', { headers: { host: '127.0.0.1:4242' } });
    expect(await res.json()).toEqual({ login: false, passkeys: false, totp: false, signedIn: { goals: false, terminal: false } });
  });
});

describe('without --public-url', () => {
  it('turns passkeys away with a hint', async () => {
    const local = createApp({ keel, port: 4242, auth: { store } });
    const res = await local.request('/api/auth/signin/options', {
      method: 'POST',
      headers: { host: '127.0.0.1:4242', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(409);
  });
});

describe('TOTP codes', () => {
  const secret = newTotpSecret();
  let clock: number;
  beforeEach(() => {
    clock = 1_700_000_000_000;
    store = AuthStore.at(home, () => new Date(clock));
    store.enableTotp(totpStep(clock) - 5);
    app = createApp({ keel, port: 4242, auth: { store, publicUrl: PUBLIC, totpSecret: async () => secret, now: () => clock } });
  });
  const send = (browser: ReturnType<typeof client>, code: string, scope = 'terminal') => browser.request('/api/auth/totp/verify', { body: { scope, code } });

  it('says codes are on, and signs in with one for 12 hours', async () => {
    const browser = client();
    expect(await (await browser.request('/api/auth/state')).json()).toMatchObject({ totp: true });
    const res = await send(browser, totpCode(secret, clock));
    expect(res.status).toBe(200);
    expect(maxAge(res.headers.get('set-cookie')!)).toBeGreaterThan(12 * 3600 - 5);
    expect(maxAge(res.headers.get('set-cookie')!)).toBeLessThanOrEqual(12 * 3600);
    expect((await runToday(browser)).status).toBe(200);
    expect(store.sessions()[0]).toMatchObject({ method: 'totp', passkeyId: null, scope: 'terminal' });
  });

  it('gives a Goals code sign-in 12 hours too, not 30 days', async () => {
    const res = await send(client(), totpCode(secret, clock), 'goals');
    expect(maxAge(res.headers.get('set-cookie')!)).toBeLessThanOrEqual(12 * 3600);
  });

  it('allows one step of clock drift, and refuses a used code (no replay)', async () => {
    expect((await send(client(), totpCode(secret, clock - 30_000))).status).toBe(200);
    const code = totpCode(secret, clock);
    expect((await send(client(), code)).status).toBe(200);
    const again = await send(client(), code);
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ error: 'That code was already used.' });
    // An older step is refused once a newer one was used.
    expect((await send(client(), totpCode(secret, clock - 30_000))).status).toBe(401);
    expect((await send(client(), totpCode(secret, clock + 60_000))).status).toBe(401);
  });

  it('slows down after five wrong codes in a minute', async () => {
    for (let i = 0; i < 5; i++) expect((await send(client(), '000000')).status).toBe(401);
    expect((await send(client(), totpCode(secret, clock))).status).toBe(429);
    clock += 61_000;
    expect((await send(client(), totpCode(secret, clock))).status).toBe(200);
  });

  it('works at any address, without --public-url', async () => {
    const lan = createApp({ keel, port: 4242, host: '192.168.1.20', auth: { store, totpSecret: async () => secret, now: () => clock } });
    const res = await lan.request('/api/auth/totp/verify', {
      method: 'POST',
      headers: { host: '192.168.1.20:4242', 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'terminal', code: totpCode(secret, clock) }),
    });
    expect(res.status).toBe(200);
  });

  it('turns codes away once disabled', async () => {
    store.disableTotp();
    expect(await (await client().request('/api/auth/state')).json()).toMatchObject({ totp: false });
    expect((await send(client(), totpCode(secret, clock))).status).toBe(409);
  });
});

describe('keel serve refusal rules', () => {
  it('needs no login on this machine', () => {
    expect(checkServe({ host: '127.0.0.1' }, store)).toEqual({ login: false });
  });

  it('turns login on with --public-url', () => {
    expect(checkServe({ host: '127.0.0.1', publicUrl: PUBLIC }, store)).toEqual({ login: true });
    expect(() => checkServe({ host: '127.0.0.1', publicUrl: 'http://keel.example.ts.net' }, store)).toThrow('https://');
  });

  it('refuses another address without HTTPS, or before a login is set up', () => {
    expect(() => checkServe({ host: '0.0.0.0' }, store)).toThrow("won't listen on 0.0.0.0 without HTTPS");
    expect(() => checkServe({ host: '0.0.0.0', cert: 'c.pem', key: 'k.pem' }, store)).toThrow('before a login is set up');
    expect(() => checkServe({ host: '0.0.0.0', cert: 'c.pem' }, store)).toThrow('--cert and --key go together');
    store.completePairing(store.createPairing('My iPhone', PUBLIC).token, { credentialId: 'c', publicKey: 'k', counter: 0, transports: [] });
    expect(checkServe({ host: '0.0.0.0', cert: 'c.pem', key: 'k.pem' }, store)).toEqual({ login: true });
    expect(checkServe({ host: '0.0.0.0', publicUrl: PUBLIC }, store)).toEqual({ login: true });
  });

  it('counts codes as a login for another address', () => {
    store.enableTotp(1);
    expect(checkServe({ host: '0.0.0.0', cert: 'c.pem', key: 'k.pem' }, store)).toEqual({ login: true });
  });
});
