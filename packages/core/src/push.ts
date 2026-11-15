import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as t from './db/schema';
import { KeelError } from './errors';
import type { Store } from './store';

// ADR 0004: the devices that turned on Goals reminders. One row per push endpoint;
// subscribing again from the same device updates its keys. A device that turns
// reminders off, or that the push service says is gone, is soft-deleted.

export type PushSubscription = typeof t.pushSubscriptions.$inferSelect;

/** What the browser's `PushSubscription.toJSON()` gives, flattened. */
export interface NewPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const KEY = /^[A-Za-z0-9_-]+={0,2}$/;

function checkSubscription(sub: NewPushSubscription): void {
  let url: URL | null = null;
  try {
    url = new URL(sub.endpoint);
  } catch {
    // Reported below.
  }
  if (url?.protocol !== 'https:') throw new KeelError("That isn't a push address from a browser.", 'Turn reminders on again from the Goals app.', 'endpoint');
  if (!KEY.test(sub.p256dh) || !KEY.test(sub.auth)) throw new KeelError('The push keys are missing or malformed.', 'Turn reminders on again from the Goals app.', 'keys');
}

/** Saves a device's subscription, made with the VAPID public key `serverKey`. */
export async function savePushSubscription(k: Store, sub: NewPushSubscription, serverKey: string): Promise<void> {
  checkSubscription(sub);
  const at = k.iso();
  const fields = { p256dh: sub.p256dh, auth: sub.auth, serverKey, updatedAt: at, deletedAt: null };
  await k.batch([
    k.db
      .insert(t.pushSubscriptions)
      .values({ id: k.newId(), createdAt: at, endpoint: sub.endpoint, ...fields })
      .onConflictDoUpdate({ target: t.pushSubscriptions.endpoint, set: fields }),
  ]);
}

/** Turns reminders off for one device (or forgets one the push service says is gone). False when it was not subscribed. */
export async function removePushSubscription(k: Store, endpoint: string): Promise<boolean> {
  const found = await k.db
    .select({ id: t.pushSubscriptions.id })
    .from(t.pushSubscriptions)
    .where(and(eq(t.pushSubscriptions.endpoint, endpoint), isNull(t.pushSubscriptions.deletedAt)));
  if (!found.length) return false;
  const at = k.iso();
  await k.batch([k.db.update(t.pushSubscriptions).set({ deletedAt: at, updatedAt: at }).where(eq(t.pushSubscriptions.endpoint, endpoint))]);
  return true;
}

/** The devices this server can send to: subscribed with its VAPID key and not removed. */
export function pushSubscriptions(k: Store, serverKey: string): Promise<PushSubscription[]> {
  return k.db
    .select()
    .from(t.pushSubscriptions)
    .where(and(eq(t.pushSubscriptions.serverKey, serverKey), isNull(t.pushSubscriptions.deletedAt)));
}

/** Records that a push reached these devices' push service. */
export async function markPushUsed(k: Store, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const at = k.iso();
  await k.batch([k.db.update(t.pushSubscriptions).set({ lastUsedAt: at, updatedAt: at }).where(inArray(t.pushSubscriptions.id, ids))]);
}
