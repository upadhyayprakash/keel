import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '../src/db/schema';
import { closeGoal, createGoal, deadlinePadding, goalReview, paddedDeadline, paddingFrom, paddingNote, planVsTook, type NewGoal } from '../src/goals';
import type { Keel } from '../src/keel';
import { renderText } from '../src/render-text';
import { openTestKeel } from './helpers';

// Close and review, and the deadline padding it feeds (ADR 0004, slice 06).

// Monday 12 October 2026, 09:00 local time; tests move it on.
let now: Date;
let keel: Keel;
const run = async (line: string) => renderText(await keel.run(line));
const json = async (line: string) => {
  const block = (await keel.exec(line)).blocks[0];
  if (block?.kind !== 'raw') throw new Error(`expected raw JSON, got ${JSON.stringify(block)}`);
  return JSON.parse(block.text) as { ok: boolean; data: any; error?: string };
};

/** Runs an interactive command, answering each question in order. */
async function play(line: string, answers: string[]) {
  let result = await keel.exec(line);
  const out = [renderText(result.blocks)];
  const questions: string[] = [];
  while (result.question && result.session) {
    questions.push(result.question.prompt);
    if (answers.length === 0) throw new Error(`No answer left for "${result.question.prompt}"`);
    result = await keel.answer(result.session, answers.shift()!);
    out.push(renderText(result.blocks));
  }
  return { text: out.join('\n'), questions };
}

const goal = (over: Partial<NewGoal> = {}): NewGoal => ({
  title: 'Run 5 km',
  doneMeans: 'I run 5 km in one go',
  dueOn: '2026-10-22',
  obstacle: 'rainy mornings',
  plan: 'If it rains, then I will use the treadmill.',
  steps: [{ text: 'Run 1 km' }, { text: 'Run 5 km' }],
  ...over,
});

/** A finished or dropped goal's review, written straight to the table. */
async function pastReview(outcome: 'done' | 'dropped', plannedDays: number, tookDays: number) {
  const k = keel.store;
  await k.db.insert(t.goalReviews).values({ id: k.newId(), ...k.stamps(), goalId: k.newId(), outcome, plannedDays, tookDays });
}

beforeEach(async () => {
  now = new Date(2026, 9, 12, 9, 0);
  keel = await openTestKeel(() => now);
});

afterEach(() => keel.close());

describe('padding', () => {
  it('compares days taken with days planned, over finished goals only', () => {
    expect(paddingFrom([])).toBeNull();
    expect(paddingFrom([{ plannedDays: 10, tookDays: 13 }])).toEqual({ goals: 1, percent: 30, ratio: 1.3 });
    expect(paddingFrom([{ plannedDays: 10, tookDays: 12 }, { plannedDays: 20, tookDays: 27 }])).toMatchObject({ goals: 2, percent: 30 });
    // On time, early, or barely late: nothing to pad.
    expect(paddingFrom([{ plannedDays: 10, tookDays: 10 }])).toBeNull();
    expect(paddingFrom([{ plannedDays: 10, tookDays: 7 }])).toBeNull();
    expect(paddingFrom([{ plannedDays: 20, tookDays: 21 }])).toBeNull();
    // A goal due the day it started says nothing about pace.
    expect(paddingFrom([{ plannedDays: 0, tookDays: 5 }])).toBeNull();
  });

  it('stretches the days left by the same share, rounded up', () => {
    const padding = { goals: 2, percent: 30, ratio: 1.3 };
    expect(paddedDeadline('2026-10-12', '2026-11-08', padding)).toBe('2026-11-17'); // 27 days -> 36
    expect(paddedDeadline('2026-10-12', '2026-10-12', padding)).toBe('2026-10-12');
    expect(paddingNote(padding)).toBe('Your last 2 goals took 30% longer than planned.');
    expect(paddingNote({ ...padding, goals: 1 })).toBe('Your last goal took 30% longer than planned.');
  });

  it('reads the last 3 finished goals and leaves dropped ones out', async () => {
    expect(await deadlinePadding(keel.store)).toBeNull();
    await pastReview('done', 10, 30); // oldest, beyond the last 3
    now = new Date(2026, 9, 13, 9, 0);
    await pastReview('done', 10, 12);
    now = new Date(2026, 9, 14, 9, 0);
    await pastReview('dropped', 10, 40);
    await pastReview('done', 10, 13);
    now = new Date(2026, 9, 15, 9, 0);
    await pastReview('done', 10, 14);
    expect(await deadlinePadding(keel.store)).toMatchObject({ goals: 3, percent: 30 });
  });
});

describe('closeGoal', () => {
  it('writes the review with planned and taken days in the same batch', async () => {
    const { goal: g } = await createGoal(keel.store, goal());
    expect(planVsTook(g, '2026-10-24')).toEqual({ plannedDays: 10, tookDays: 12 });
    now = new Date(2026, 9, 24, 18, 0);
    await closeGoal(keel.store, 'g1', 'done', { happened: ' Ran it two days late ', why: '', change: 'Start sooner' });
    expect(await goalReview(keel.store, g.id)).toMatchObject({ outcome: 'done', plannedDays: 10, tookDays: 12, happened: 'Ran it two days late', why: null, change: 'Start sooner' });
    expect(await deadlinePadding(keel.store)).toMatchObject({ goals: 1, percent: 20 });
  });

  it('saves no review when another device closed the goal first', async () => {
    const { goal: g } = await createGoal(keel.store, goal());
    await closeGoal(keel.store, 'g1', 'dropped');
    await expect(closeGoal(keel.store, 'g1', 'done', { happened: 'x' })).rejects.toThrow('g1 is already dropped');
    const rows = await keel.store.db.select().from(t.goalReviews).where(eq(t.goalReviews.goalId, g.id));
    expect(rows.map((r) => r.outcome)).toEqual(['dropped']);
  });
});

describe('goal done and goal drop', () => {
  it('shows planned against taken, asks the three questions, and goal show has the review', async () => {
    await createGoal(keel.store, goal());
    now = new Date(2026, 9, 24, 18, 0);
    const { text, questions } = await play('goal done g1', ['Ran it, two days late', 'Two rainy days', 'Plan the treadmill first']);
    expect(questions).toEqual(['What happened, against the plan?', 'Why?', 'What will you change next time?']);
    expect(text).toContain('Planned 10 days, took 12: 2 days over.');
    expect(text).toContain('Your answers help pad the deadline of your next goal.');
    expect(text).toContain('g1 Run 5 km is done.');
    const shown = await run('goal show g1');
    expect(shown).toMatch(/REVIEW[\s\S]*days\s+planned 10, took 12[\s\S]*happened\s+Ran it, two days late[\s\S]*why\s+Two rainy days[\s\S]*next time\s+Plan the treadmill first/);
  });

  it('refuses a closed goal before asking anything', async () => {
    await createGoal(keel.store, goal());
    await closeGoal(keel.store, 'g1', 'done');
    const { text, questions } = await play('goal drop g1', []);
    expect(questions).toEqual([]);
    expect(text).toContain('g1 is already done');
  });

  it('takes the answers inline and asks none, also with --json', async () => {
    await createGoal(keel.store, goal());
    await createGoal(keel.store, goal({ title: 'Read a book' }));
    const { questions } = await play('goal drop g1 happened:"Lost interest" change:"Pick something I want"', []);
    expect(questions).toEqual([]);
    expect(await run('goal show g1')).toMatch(/happened\s+Lost interest[\s\S]*next time\s+Pick something I want/);
    const out = await json('goal done g2 --json');
    expect(out.ok).toBe(true);
    expect(out.data.status).toBe('done');
  });
});

describe('goal new with padding', () => {
  const ASKED = 'goal new "Read a book" done:"Last page read" obstacle:"late nights" plan:"If I am tired, then I will read 5 pages" step:"Read chapter 1"';

  it('offers the padded deadline when past goals ran late', async () => {
    await pastReview('done', 10, 13);
    const { text, questions } = await play(ASKED, ['nov 8', 'y', '']);
    expect(questions).toEqual(['Deadline?', 'Use Tue 17 Nov instead?', 'How much time will you give it?']);
    expect(text).toContain('Your last goal took 30% longer than planned. Tue 17 Nov would allow for that.');
    expect((await json('goal show g1 --json')).data.dueOn).toBe('2026-11-17');
  });

  it('keeps the deadline on enter, and asks nothing when there is no padding or the deadline is inline', async () => {
    await pastReview('done', 10, 13);
    await play(ASKED, ['nov 8', '', '']);
    expect((await json('goal show g1 --json')).data.dueOn).toBe('2026-11-08');
    const { questions } = await play(`${ASKED} due:2026-11-08`, ['']);
    expect(questions).toEqual(['How much time will you give it?']);
    await keel.store.db.delete(t.goalReviews);
    const fresh = await play(ASKED, ['nov 8', '']);
    expect(fresh.questions).toEqual(['Deadline?', 'How much time will you give it?']);
  });
});

describe('export', () => {
  it('carries reviews in the JSON and the Markdown', async () => {
    await createGoal(keel.store, goal());
    now = new Date(2026, 9, 24, 18, 0);
    await closeGoal(keel.store, 'g1', 'done', { happened: 'Ran it', why: 'Rain', change: 'Start sooner' });
    const block = (await keel.exec('export')).blocks[0];
    if (block?.kind !== 'raw') throw new Error('expected raw JSON');
    const dump = JSON.parse(block.text);
    expect(dump.data.goalReviews).toHaveLength(1);
    const md = await run('export --md');
    expect(md).toContain('- Planned 10 days, took 12');
    expect(md).toContain('- Next time: Start sooner');
  });
});
