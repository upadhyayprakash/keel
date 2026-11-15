import type { Context, Hono } from 'hono';
import webpush from 'web-push';
import { KeelError, markPushUsed, pushSubscriptions, removePushSubscription, savePushSubscription, type Keel } from '@keel/core';

// ADR 0004: web push for Goals reminders, with VAPID keys and the `web-push` library
// (no push service of our own). The keys are made the first time a device asks for
// them and kept with Keel's other secrets (Keychain, keyring or the 600 file).

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** The part of the CLI's secret store push needs. */
export interface KeyStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string, label?: string): Promise<void>;
}

export const VAPID_ACCOUNT = 'goals-push-vapid';
const VAPID_LABEL = 'Keel reminders push key';

export interface Vapid {
  /** The keys, when a device has asked for them before. */
  existing(): Promise<VapidKeys | null>;
  /** The keys, made and saved on first use. */
  ensure(): Promise<VapidKeys>;
}

/** VAPID keys from the secret store, saved as `<public>.<private>` (both base64url, so a dot cannot appear in them). */
export function vapidFrom(secrets: KeyStore): Vapid {
  let keys: VapidKeys | null = null;
  const read = async () => {
    if (keys) return keys;
    const [publicKey, privateKey] = (await secrets.get(VAPID_ACCOUNT))?.split('.') ?? [];
    return (keys = publicKey && privateKey ? { publicKey, privateKey } : null);
  };
  return {
    existing: read,
    async ensure() {
      const found = await read();
      if (found) return found;
      const made = webpush.generateVAPIDKeys();
      await secrets.set(VAPID_ACCOUNT, `${made.publicKey}.${made.privateKey}`, VAPID_LABEL);
      return (keys = made);
    },
  };
}

/** What the Goals service worker shows. `url` is opened on a tap; actions are the notification's buttons. */
export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  /** A newer notification with the same tag replaces the older one. */
  tag?: string;
  actions?: Array<{ action: string; title: string }>;
  data?: Record<string, unknown>;
}

export type SendPush = (subscription: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;

export interface PushOptions {
  vapid: Vapid;
  /** Who push services can contact about this sender: the public URL, or Keel's homepage. */
  subject: string;
  /** Replaces `webpush.sendNotification` in tests. */
  send?: SendPush;
}

export interface PushResult {
  sent: number;
  /** Devices the push service says are gone (404, 410), now forgotten. */
  removed: number;
  failed: number;
}

/** A reminder is worth nothing after the 12-hour catch-up window, so push services may drop it then. */
const TTL_SECONDS = 12 * 60 * 60;

export interface PushSender {
  sendToAll(message: PushMessage): Promise<PushResult>;
}

export function pushSender(keel: Keel, { vapid, subject, send = webpush.sendNotification }: PushOptions): PushSender {
  const k = keel.store;
  return {
    async sendToAll(message) {
      const result: PushResult = { sent: 0, removed: 0, failed: 0 };
      const keys = await vapid.existing();
      if (!keys) return result; // no device has asked yet
      const options: webpush.RequestOptions = { TTL: TTL_SECONDS, urgency: 'high', vapidDetails: { subject, ...keys } };
      const payload = JSON.stringify(message);
      const reached: string[] = [];
      for (const sub of await pushSubscriptions(k, keys.publicKey)) {
        try {
          await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, options);
          reached.push(sub.id);
          result.sent++;
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await removePushSubscription(k, sub.endpoint);
            result.removed++;
          } else {
            console.error(`Push to ${new URL(sub.endpoint).host} failed: ${(e as Error).message}`);
            result.failed++;
          }
        }
      }
      await markPushUsed(k, reached);
      return result;
    },
  };
}

const problem = (c: Context, status: 400 | 404 | 503, error: string, hint: string | null = null, field: string | null = null) => c.json({ error, hint, field }, status);

async function jsonBody(c: Context): Promise<Record<string, unknown> | Response> {
  if (!c.req.header('content-type')?.startsWith('application/json')) return c.text('Expected JSON', 415);
  const body = await c.req.json<unknown>().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return problem(c, 400, 'Expected a JSON object.');
  return body as Record<string, unknown>;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * The Goals app's reminder routes, under /api/goals/push so a Goals session covers them.
 * Registered before /api/goals/:ref, so "push" is never read as a goal.
 */
export function pushRoutes(app: Hono, keel: Keel, push: PushOptions | undefined): void {
  const k = keel.store;
  const sender = push && pushSender(keel, push);
  const off = (c: Context) => problem(c, 503, "Reminders aren't available on this server.", 'Run keel serve to send reminders.');

  // The VAPID public key for `pushManager.subscribe({ applicationServerKey })`.
  app.get('/api/goals/push', async (c) => (push ? c.json({ publicKey: (await push.vapid.ensure()).publicKey }) : off(c)));

  // Body: the browser's PushSubscription JSON ({ endpoint, keys: { p256dh, auth } }).
  app.post('/api/goals/push/subscribe', async (c) => {
    if (!push) return off(c);
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    const keys = body.keys && typeof body.keys === 'object' ? (body.keys as Record<string, unknown>) : {};
    try {
      await savePushSubscription(k, { endpoint: str(body.endpoint), p256dh: str(keys.p256dh), auth: str(keys.auth) }, (await push.vapid.ensure()).publicKey);
    } catch (e) {
      if (e instanceof KeelError) return problem(c, 400, e.message, e.hint ?? null, e.field ?? null);
      throw e;
    }
    return c.json({ subscribed: true }, 201);
  });

  app.post('/api/goals/push/unsubscribe', async (c) => {
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    const removed = await removePushSubscription(k, str(body.endpoint));
    return removed ? c.json({ subscribed: false }) : problem(c, 404, "This device wasn't getting reminders.");
  });

  // "Send a test reminder": proves the whole path, from this server to the phone's lock screen.
  app.post('/api/goals/push/test', async (c) => {
    if (!sender) return off(c);
    const result = await sender.sendToAll({ title: 'Reminders are on', body: 'Keel will remind you here at the times you plan.', url: '/goals/', tag: 'keel-test' });
    return c.json(result);
  });
}
