import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGoal, findGoal, Keel } from '@keel/core';
import type { PushMessage, PushSender } from '../src/push';
import { startScheduler } from '../src/scheduler';

// The reminder rounds `keel serve` runs each minute (ADR 0004, slice 03 phase 2).

let now: Date;
let keel: Keel;
let sent: PushMessage[];
const sender: PushSender = { sendToAll: async (m) => (sent.push(m), { sent: 1, removed: 0, failed: 0 }) };
const at = (day: number, hour: number, minute = 0) => (now = new Date(2026, 9, day, hour, minute));

beforeEach(async () => {
  at(12, 9);
  keel = await Keel.open({ url: ':memory:', now: () => now });
  sent = [];
  await createGoal(keel.store, {
    title: 'Run 5 km',
    doneMeans: 'I run 5 km in one go',
    dueOn: '2026-11-08',
    plan: 'If it rains, then I will use the treadmill.',
    steps: [
      { text: 'Run 1 km', cueAt: '2026-10-17T07:00', minimum: '10 minutes' },
      { text: 'Run 3 km', cueAt: '2026-10-17T08:00' },
    ],
  });
});

afterEach(() => keel.close());

describe('scheduler', () => {
  it('sends each cue on time, once', async () => {
    const scheduler = startScheduler(keel, sender, { timers: false });
    at(17, 7, 0);
    await scheduler.tick();
    at(17, 7, 1);
    await scheduler.tick();
    at(17, 8, 0);
    await scheduler.tick();
    expect(sent.map((m) => m.title)).toEqual(['Run 1 km', 'Run 3 km']);
  });

  it('on start after a sleep, sends the missed cues as one catch-up push', async () => {
    at(17, 9, 15);
    await startScheduler(keel, sender, { timers: false }).tick();
    expect(sent.map((m) => m.title)).toEqual(['You missed 2 planned steps']);
  });

  it('marks missed cues the next day, also with no device subscribed', async () => {
    const quiet: PushSender = { sendToAll: async () => ({ sent: 0, removed: 0, failed: 0 }) };
    const scheduler = startScheduler(keel, quiet, { timers: false });
    at(17, 7, 0);
    await scheduler.tick();
    at(18, 0, 1);
    await scheduler.tick();
    expect((await findGoal(keel.store, 'g1')).goal.missedInARow).toBe(2);
  });

  it('never runs two rounds at once', async () => {
    let release!: () => void;
    const slow: PushSender = { sendToAll: (m) => new Promise((done) => ((release = () => done({ sent: 1, removed: 0, failed: 0 })), sent.push(m))) };
    const scheduler = startScheduler(keel, slow, { timers: false });
    at(17, 7, 0);
    const first = scheduler.tick();
    const second = scheduler.tick();
    expect(second).toBe(first);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await first;
    await scheduler.tick();
    expect(sent.map((m) => m.title)).toEqual(['Run 1 km']);
  });

  it('keeps going after a failed round', async () => {
    const errors: unknown[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      let fail = true;
      const flaky: PushSender = {
        sendToAll: async (m) => {
          if (fail) throw new Error('push service down');
          sent.push(m);
          return { sent: 1, removed: 0, failed: 0 };
        },
      };
      const scheduler = startScheduler(keel, flaky, { timers: false });
      at(17, 7, 0);
      await scheduler.tick();
      fail = false;
      at(17, 7, 1);
      await scheduler.tick(); // not marked as sent the first time, so it goes now
      expect(sent.map((m) => m.title)).toEqual(['Run 1 km']);
    } finally {
      console.error = quiet;
    }
    expect(errors).toHaveLength(1);
  });
});
