import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keel, pushSubscriptions } from '@keel/core';
import { createApp } from '../src/index';
import { pushSender, vapidFrom, VAPID_ACCOUNT, type KeyStore, type SendPush } from '../src/push';

// Goals reminders over web push (ADR 0004, slice 03 phase 1).

const HOST = { host: '127.0.0.1:4242' };
const PHONE = { endpoint: 'https://web.push.apple.com/QGx1', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } };
const LAPTOP = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: PHONE.keys };

/** A secret store in memory, like the Keychain. */
function memorySecrets(): KeyStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (a) => data.get(a) ?? null, set: async (a, s) => void data.set(a, s) };
}

let keel: Keel;
let secrets: ReturnType<typeof memorySecrets>;
let sent: Array<{ endpoint: string; payload: unknown; ttl: number | undefined }>;
let reply: (endpoint: string) => void;
const send: SendPush = async (sub, payload, options) => {
  reply(sub.endpoint);
  sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), ttl: options.TTL });
};

beforeEach(async () => {
  keel = await Keel.open({ url: ':memory:', now: () => new Date(2026, 9, 12, 9, 0) });
  secrets = memorySecrets();
  sent = [];
  reply = () => {};
});

afterEach(() => keel.close());

const appWith = (push = true) => createApp({ keel, port: 4242, push: push ? { vapid: vapidFrom(secrets), subject: 'https://keel.example.ts.net', send } : undefined });
const get = (app: ReturnType<typeof createApp>, path: string) => app.request(path, { headers: HOST });
const post = (app: ReturnType<typeof createApp>, path: string, body?: unknown, type = 'application/json') =>
  app.request(path, { method: 'POST', headers: { ...HOST, 'content-type': type }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('VAPID keys', () => {
  it('are made on first use, saved with the secrets, and the same afterwards', async () => {
    const vapid = vapidFrom(secrets);
    expect(await vapid.existing()).toBeNull();
    const keys = await vapid.ensure();
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/); // an uncompressed P-256 point
    expect(secrets.data.get(VAPID_ACCOUNT)).toBe(`${keys.publicKey}.${keys.privateKey}`);
    expect(await vapidFrom(secrets).existing()).toEqual(keys);
    expect(await vapidFrom(secrets).ensure()).toEqual(keys);
  });
});

describe('push routes', () => {
  it('gives the public key, subscribes a device and turns it off again', async () => {
    const app = appWith();
    const key = (await (await get(app, '/api/goals/push')).json()) as { publicKey: string };
    expect(key.publicKey).toBe((await vapidFrom(secrets).existing())!.publicKey);

    const res = await post(app, '/api/goals/push/subscribe', PHONE);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ subscribed: true });
    expect(await pushSubscriptions(keel.store, key.publicKey)).toHaveLength(1);

    expect((await post(app, '/api/goals/push/unsubscribe', { endpoint: PHONE.endpoint })).status).toBe(200);
    expect(await pushSubscriptions(keel.store, key.publicKey)).toEqual([]);
    expect((await post(app, '/api/goals/push/unsubscribe', { endpoint: PHONE.endpoint })).status).toBe(404);
  });

  it('says what is wrong with a subscription', async () => {
    const app = appWith();
    const bad = await post(app, '/api/goals/push/subscribe', { endpoint: 'http://example.com', keys: PHONE.keys });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { field: string }).field).toBe('endpoint');
    expect(((await (await post(app, '/api/goals/push/subscribe', { endpoint: PHONE.endpoint })).json()) as { field: string }).field).toBe('keys');
    expect((await post(app, '/api/goals/push/subscribe', PHONE, 'text/plain')).status).toBe(415);
    expect((await post(app, '/api/goals/push/subscribe', [PHONE])).status).toBe(400);
  });

  it('answers 503 when the server has no push, and is never read as a goal', async () => {
    const app = appWith(false);
    expect((await get(app, '/api/goals/push')).status).toBe(503);
    expect((await post(app, '/api/goals/push/subscribe', PHONE)).status).toBe(503);
    expect((await post(app, '/api/goals/push/test')).status).toBe(503);
  });

  it('sends a test reminder to every device', async () => {
    const app = appWith();
    await get(app, '/api/goals/push');
    await post(app, '/api/goals/push/subscribe', PHONE);
    await post(app, '/api/goals/push/subscribe', LAPTOP);
    const res = await post(app, '/api/goals/push/test');
    expect(await res.json()).toEqual({ sent: 2, removed: 0, failed: 0 });
    expect(sent.map((s) => s.endpoint).sort()).toEqual([LAPTOP.endpoint, PHONE.endpoint]);
    expect(sent[0]).toMatchObject({ payload: { title: 'Reminders are on', url: '/goals/', tag: 'keel-test' }, ttl: 12 * 60 * 60 });
  });
});

describe('pushSender', () => {
  it('sends nothing before any device asked for the keys', async () => {
    const sender = pushSender(keel, { vapid: vapidFrom(secrets), subject: 'https://keel.example.ts.net', send });
    expect(await sender.sendToAll({ title: 'x', body: 'y' })).toEqual({ sent: 0, removed: 0, failed: 0 });
    expect(secrets.data.size).toBe(0);
  });

  it('forgets devices the push service says are gone, and keeps the others', async () => {
    const app = appWith();
    await get(app, '/api/goals/push');
    await post(app, '/api/goals/push/subscribe', PHONE);
    await post(app, '/api/goals/push/subscribe', LAPTOP);
    const errors: unknown[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      reply = (endpoint) => {
        if (endpoint === PHONE.endpoint) throw Object.assign(new Error('Gone'), { statusCode: 410 });
        throw Object.assign(new Error('Server error'), { statusCode: 500 });
      };
      const sender = pushSender(keel, { vapid: vapidFrom(secrets), subject: 'https://keel.example.ts.net', send });
      expect(await sender.sendToAll({ title: 'x', body: 'y' })).toEqual({ sent: 0, removed: 1, failed: 1 });
    } finally {
      console.error = quiet;
    }
    expect(errors).toHaveLength(1);
    const left = await pushSubscriptions(keel.store, (await vapidFrom(secrets).existing())!.publicKey);
    expect(left.map((s) => s.endpoint)).toEqual([LAPTOP.endpoint]);
  });
});
