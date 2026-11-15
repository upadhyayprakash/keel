import { detectMissedCues, dueCues, isConnectionError, markCuesPushed, reminderMessages, type Keel } from '@keel/core';
import type { PushSender } from './push';

// ADR 0004, section 5: while `keel serve` runs, cue reminders go out each minute.
// The first tick runs at start, so cues missed while it was down arrive as one
// catch-up push. A laptop waking from sleep is the same case: the timer fires
// late and the cues it slept through are older than 5 minutes.

export interface Scheduler {
  /** One round: send due cues, then mark missed ones. Exposed for tests. */
  tick(): Promise<void>;
  stop(): void;
}

export function startScheduler(keel: Keel, sender: PushSender, { every = 60_000, timers = true } = {}): Scheduler {
  const k = keel.store;
  let running: Promise<void> | null = null;

  async function round() {
    if (k.offline) return; // a synced copy that can't reach its primary is read-only
    const due = await dueCues(k);
    for (const message of reminderMessages(due, k.today())) await sender.sendToAll(message);
    // Marked even when no device is subscribed: a reminder for a time that has passed helps no one.
    await markCuesPushed(k, due);
    await detectMissedCues(k);
  }

  // Never two rounds at once: a slow push service must not cause double reminders.
  const tick = () =>
    (running ??= round()
      .catch((e: unknown) => {
        if (isConnectionError(e)) return; // the hosted database is away; the next tick tries again
        console.error(`Reminders: ${(e as Error).message}`);
      })
      .finally(() => (running = null)));

  const timer = timers ? setInterval(() => void tick(), every) : null;
  timer?.unref();
  if (timers) void tick();
  return {
    tick,
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
