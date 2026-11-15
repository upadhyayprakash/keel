import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeStep, createGoal, findGoal, type NewGoal } from '../src/goals';
import type { Keel } from '../src/keel';
import { detectMissedCues, dueCues, markCuesPushed, reminderMessages } from '../src/reminders';
import { renderText } from '../src/render-text';
import { openTestKeel } from './helpers';

// Cue reminders and missed cues (ADR 0004, slice 03 phase 2), on a fake clock.

// Monday 12 October 2026, 09:00 local time; tests move it on.
let now: Date;
let keel: Keel;
const at = (day: number, hour: number, minute = 0) => (now = new Date(2026, 9, day, hour, minute));

const RUN: NewGoal = {
  title: 'Run 5 km',
  doneMeans: 'I run 5 km in one go',
  dueOn: '2026-11-08',
  plan: 'If it rains, then I will use the treadmill.',
  steps: [
    { text: 'Run 1 km', cueAt: '2026-10-17T07:00', cuePlace: 'the park', minimum: '10 minutes' },
    { text: 'Run 3 km', cueAt: '2026-10-19T07:00' },
    { text: 'Run 5 km' },
  ],
};

/** What one scheduler round would send, after which the cues count as sent. */
async function round() {
  const due = await dueCues(keel.store);
  const messages = reminderMessages(due, keel.store.today());
  await markCuesPushed(keel.store, due);
  return messages;
}

beforeEach(async () => {
  at(12, 9);
  keel = await openTestKeel(() => now);
  await createGoal(keel.store, RUN);
});

afterEach(() => keel.close());

describe('cue reminders', () => {
  it('sends a cue at its time with Done and the fallback, and only once', async () => {
    at(17, 6, 59);
    expect(await round()).toEqual([]);
    at(17, 7, 0);
    expect(await round()).toEqual([
      {
        title: 'Run 1 km',
        body: '07:00 at the park, for Run 5 km.',
        url: '/goals/g1',
        tag: 'keel-cue-g1-1',
        actions: [
          { action: 'done', title: 'Done' },
          { action: 'fallback', title: 'Do the fallback' },
        ],
        data: { kind: 'cue', goal: 'g1', position: 1, cueAt: '2026-10-17T07:00' },
      },
    ]);
    at(17, 7, 1);
    expect(await round()).toEqual([]);
  });

  it('offers only Done for a step without a smaller version', async () => {
    at(19, 7, 2);
    const [message] = await round();
    expect(message).toMatchObject({ title: 'Run 3 km', body: '07:00, for Run 5 km.', actions: [{ action: 'done', title: 'Done' }] });
  });

  it('sends one catch-up push for a cue slept through', async () => {
    at(17, 9, 30); // the laptop woke at 9:30
    expect(await round()).toEqual([
      expect.objectContaining({
        title: 'You planned Run 1 km at 07:00',
        body: 'Do the smaller version instead: 10 minutes.',
        tag: 'keel-catch-up',
        data: { kind: 'catch-up', goal: 'g1', position: 1, cueAt: '2026-10-17T07:00' },
      }),
    ]);
    expect(await round()).toEqual([]);
  });

  it('puts every late cue into one push, never one per cue', async () => {
    await createGoal(keel.store, { ...RUN, title: 'Read a book', steps: [{ text: 'Read chapter 1', cueAt: '2026-10-17T08:00' }] });
    at(17, 18, 0);
    const messages = await round();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ title: 'You missed 2 planned steps', body: 'Run 1 km at 07:00, Read chapter 1 at 08:00.', url: '/goals/', data: { kind: 'catch-up' } });
    expect(messages[0]!.actions).toBeUndefined();
  });

  it('drops cues older than 12 hours, and steps already done', async () => {
    at(17, 19, 1);
    expect(await round()).toEqual([]);
    at(19, 6, 0);
    await completeStep(keel.store, 'g1', 2);
    at(19, 7, 0);
    expect(await round()).toEqual([]);
  });

  it('sends nothing for a closed goal', async () => {
    await keel.run('goal drop g1 happened:"Changed plans"');
    at(17, 7, 0);
    expect(await round()).toEqual([]);
  });

  it('sends a moved cue again at its new time', async () => {
    at(17, 7, 0);
    await round();
    // Phase 4's "Reschedule" moves the cue; written straight here.
    const { goalSteps } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const [step] = (await findGoal(keel.store, 'g1')).steps;
    await keel.store.db.update(goalSteps).set({ cueAt: '2026-10-18T07:00' }).where(eq(goalSteps.id, step!.id));
    at(18, 7, 0);
    expect((await round()).map((m) => m.title)).toEqual(['Run 1 km']);
  });
});

describe('missed cues', () => {
  it('marks a cue missed once its day ends with the step open, and flags the second miss', async () => {
    at(17, 23, 59);
    expect(await detectMissedCues(keel.store)).toEqual([]);
    expect((await findGoal(keel.store, 'g1')).goal.missedInARow).toBe(0);

    at(18, 0, 1);
    expect(await detectMissedCues(keel.store)).toEqual([]);
    const once = await findGoal(keel.store, 'g1');
    expect(once.goal.missedInARow).toBe(1);
    expect(await detectMissedCues(keel.store)).toEqual([]); // marked only once
    expect((await findGoal(keel.store, 'g1')).goal.missedInARow).toBe(1);

    at(20, 6, 0);
    const flagged = await detectMissedCues(keel.store);
    expect(flagged.map((g) => [g.title, g.missedInARow])).toEqual([['Run 5 km', 2]]);
    const shown = renderText(await keel.run('goal show g1'));
    expect(shown).toMatch(/Run 1 km[^\n]*missed/);
    expect(shown).toContain('2 planned steps missed in a row.');
    const json = JSON.parse(((await keel.exec('goal show g1 --json')).blocks[0] as { text: string }).text);
    expect(json.data.missedInARow).toBe(2);
    expect(json.data.steps.map((s: { missed: boolean }) => s.missed)).toEqual([true, true, false]);
  });

  it('starts counting again when a step is done', async () => {
    at(18, 0, 1);
    await detectMissedCues(keel.store);
    at(18, 9, 0);
    await completeStep(keel.store, 'g1', 1);
    const view = await findGoal(keel.store, 'g1');
    expect(view.goal.missedInARow).toBe(0);
    expect(renderText(await keel.run('goal show g1'))).not.toContain('missed');
  });

  it('does not send a reminder for a cue already missed', async () => {
    await createGoal(keel.store, { ...RUN, title: 'Write', steps: [{ text: 'Write a page', cueAt: '2026-10-17T23:58' }] });
    at(18, 0, 30);
    await detectMissedCues(keel.store);
    expect((await round()).map((m) => m.title)).not.toContain('You planned Write a page at 23:58');
  });
});
