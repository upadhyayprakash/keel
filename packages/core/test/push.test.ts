import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as t from '../src/db/schema';
import { markPushUsed, pushSubscriptions, removePushSubscription, savePushSubscription } from '../src/push';
import type { Keel } from '../src/keel';
import { openTestKeel } from './helpers';

// The devices that turned on Goals reminders (ADR 0004, slice 03).

let now: Date;
let keel: Keel;
const PHONE = { endpoint: 'https://web.push.apple.com/QGx1', p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };

beforeEach(async () => {
  now = new Date(2026, 9, 12, 9, 0);
  keel = await openTestKeel(() => now);
});

afterEach(() => keel.close());

describe('push subscriptions', () => {
  it('saves a device once, and subscribing again updates its keys', async () => {
    const k = keel.store;
    await savePushSubscription(k, PHONE, 'key-a');
    await savePushSubscription(k, { ...PHONE, auth: 'bmV3LWF1dGg' }, 'key-a');
    const subs = await pushSubscriptions(k, 'key-a');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ endpoint: PHONE.endpoint, auth: 'bmV3LWF1dGg', serverKey: 'key-a', lastUsedAt: null });
  });

  it('only lists devices subscribed with this server key', async () => {
    const k = keel.store;
    await savePushSubscription(k, PHONE, 'key-a');
    expect(await pushSubscriptions(k, 'key-b')).toEqual([]);
    // Subscribing again with the new key moves the device over.
    await savePushSubscription(k, PHONE, 'key-b');
    expect(await pushSubscriptions(k, 'key-a')).toEqual([]);
    expect(await pushSubscriptions(k, 'key-b')).toHaveLength(1);
  });

  it('turns a device off softly, and on again', async () => {
    const k = keel.store;
    await savePushSubscription(k, PHONE, 'key-a');
    expect(await removePushSubscription(k, PHONE.endpoint)).toBe(true);
    expect(await removePushSubscription(k, PHONE.endpoint)).toBe(false);
    expect(await pushSubscriptions(k, 'key-a')).toEqual([]);
    expect(await k.db.select().from(t.pushSubscriptions)).toHaveLength(1); // soft delete
    await savePushSubscription(k, PHONE, 'key-a');
    expect(await pushSubscriptions(k, 'key-a')).toHaveLength(1);
  });

  it('records when a push reached a device', async () => {
    const k = keel.store;
    await savePushSubscription(k, PHONE, 'key-a');
    const [sub] = await pushSubscriptions(k, 'key-a');
    now = new Date(2026, 9, 13, 7, 0);
    await markPushUsed(k, [sub!.id]);
    expect((await pushSubscriptions(k, 'key-a'))[0]!.lastUsedAt).toBe(now.toISOString());
  });

  it('refuses anything that is not a browser push subscription', async () => {
    const k = keel.store;
    await expect(savePushSubscription(k, { ...PHONE, endpoint: 'http://example.com/x' }, 'key-a')).rejects.toMatchObject({ field: 'endpoint' });
    await expect(savePushSubscription(k, { ...PHONE, endpoint: 'not a url' }, 'key-a')).rejects.toMatchObject({ field: 'endpoint' });
    await expect(savePushSubscription(k, { ...PHONE, p256dh: '' }, 'key-a')).rejects.toMatchObject({ field: 'keys' });
    await expect(savePushSubscription(k, { ...PHONE, auth: 'has spaces' }, 'key-a')).rejects.toMatchObject({ field: 'keys' });
  });
});
