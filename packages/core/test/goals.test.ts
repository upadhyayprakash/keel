import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDb, openDb, upToDate } from '../src/db/client';
import * as t from '../src/db/schema';
import { closeGoal, completeStep, createGoal, findGoal, listGoals, updateGoal, type NewGoal } from '../src/goals';
import type { Keel } from '../src/keel';
import type { Store } from '../src/store';
import { openTestKeel } from './helpers';

// Monday 12 October 2026, 09:00 local time.
const now = () => new Date(2026, 9, 12, 9, 0);
let keel: Keel;
let k: Store;

const run5k = (over: Partial<NewGoal> = {}): NewGoal => ({
  title: 'Run 5 km',
  doneMeans: 'I run 5 km in one go',
  dueOn: '2026-11-08',
  appetite: '3 runs a week',
  obstacle: 'rainy mornings',
  plan: 'If it is raining at 7:00, then I will do 20 minutes on the treadmill.',
  steps: [{ text: 'Run 1 km', cueAt: '2026-10-13T07:00', cuePlace: 'the park', minimum: '10 minutes' }, { text: 'Run 2 km' }, { text: 'Run 5 km' }],
  ...over,
});

/** Lets "another device" act after this device has read, but before its write lands. */
function meanwhile(store: Store, other: () => Promise<unknown>): void {
  const original = store.batch.bind(store);
  store.batch = async (queries) => {
    store.batch = original;
    await other();
    return original(queries);
  };
}

const events = async (kind: string) => (await k.db.select().from(t.events)).filter((e) => e.kind === kind);

beforeEach(async () => {
  keel = await openTestKeel(now);
  k = keel.store;
});
afterEach(() => keel.close());

describe('the migration', () => {
  it('adds the goal tables to an existing 0.4 database and keeps its data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-goals-migrate-'));
    try {
      // The migrations as 0.4.0 shipped them: only 0000_init.
      const current = fileURLToPath(new URL('../drizzle', import.meta.url));
      const old = join(dir, 'drizzle');
      cpSync(current, old, { recursive: true });
      rmSync(join(old, '0001_goals.sql'));
      const journal = JSON.parse(readFileSync(join(old, 'meta', '_journal.json'), 'utf8'));
      journal.entries = journal.entries.slice(0, 1);
      writeFileSync(join(old, 'meta', '_journal.json'), JSON.stringify(journal));

      const { db, client } = openDb({ url: `file:${join(dir, 'keel.db')}` });
      await migrate(db, { migrationsFolder: old });
      await db.run(sql`insert into people (id, created_at, updated_at, handle, name) values ('p1', 'x', 'x', 'ravi', 'Ravi')`);
      expect(await upToDate(db)).toBe(false);

      await migrateDb(db);
      expect(await upToDate(db)).toBe(true);
      const tables = await client.execute("select name from sqlite_master where type = 'table'");
      expect(tables.rows.map((r) => r.name)).toEqual(expect.arrayContaining(['goals', 'goal_steps', 'write_guard']));
      expect((await db.select().from(t.people)).map((p) => p.handle)).toEqual(['ravi']);
      client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('creating a goal', () => {
  it('saves the goal and its steps, numbers it, and records an event', async () => {
    const { goal, steps } = await createGoal(k, run5k());
    expect(goal).toMatchObject({ refNo: 1, title: 'Run 5 km', status: 'active', dueOn: '2026-11-08', obstacle: 'rainy mornings' });
    expect(steps.map((s) => [s.position, s.text, s.firstStep, s.status])).toEqual([
      [1, 'Run 1 km', true, 'open'],
      [2, 'Run 2 km', false, 'open'],
      [3, 'Run 5 km', false, 'open'],
    ]);
    expect(steps[0]).toMatchObject({ cueAt: '2026-10-13T07:00', cuePlace: 'the park', minimum: '10 minutes' });
    expect((await createGoal(k, run5k({ title: 'Read a book' }))).goal.refNo).toBe(2);
    expect(await events('created')).toHaveLength(2);
  });

  it('keeps the step marked first', async () => {
    const { steps } = await createGoal(k, run5k({ steps: [{ text: 'Buy shoes' }, { text: 'Run 1 km', firstStep: true }] }));
    expect(steps.map((s) => s.firstStep)).toEqual([false, true]);
  });

  it('refuses a goal without what it needs', async () => {
    await expect(createGoal(k, run5k({ plan: 'Run more' }))).rejects.toThrow('If ..., then I will ...');
    await expect(createGoal(k, run5k({ plan: ' ' }))).rejects.toThrow('needs an if-then plan');
    await expect(createGoal(k, run5k({ doneMeans: '' }))).rejects.toThrow('what done looks like');
    await expect(createGoal(k, run5k({ dueOn: '2026-10-11' }))).rejects.toThrow('in the past');
    await expect(createGoal(k, run5k({ dueOn: '2026-02-30' }))).rejects.toThrow("isn't a date");
    await expect(createGoal(k, run5k({ steps: [] }))).rejects.toThrow('at least one step');
    await expect(createGoal(k, run5k({ steps: [{ text: 'a', firstStep: true }, { text: 'b', firstStep: true }] }))).rejects.toThrow('Only one step');
    await expect(createGoal(k, run5k({ steps: [{ text: 'a', cueAt: 'tomorrow' }] }))).rejects.toThrow("isn't a date and time");
    expect(await listGoals(k)).toEqual([]);
  });

  it('lists active goals first, nearest deadline first', async () => {
    await createGoal(k, run5k({ title: 'Later', dueOn: '2026-12-01' }));
    await createGoal(k, run5k({ title: 'Sooner', dueOn: '2026-10-30' }));
    await createGoal(k, run5k({ title: 'Closed', dueOn: '2026-10-20' }));
    await closeGoal(k, 'g3', 'dropped');
    expect((await listGoals(k)).map((v) => v.goal.title)).toEqual(['Sooner', 'Later', 'Closed']);
    expect((await listGoals(k, 'dropped')).map((v) => v.goal.title)).toEqual(['Closed']);
    expect((await findGoal(k, 'G2')).steps).toHaveLength(3);
    await expect(findGoal(k, 'g9')).rejects.toThrow('No goal g9');
  });
});

describe('guarded changes (ADR 0003)', () => {
  beforeEach(async () => void (await createGoal(k, run5k())));

  it('marks a step done, once', async () => {
    const { steps } = await completeStep(k, 'g1', 1);
    expect(steps[0]).toMatchObject({ status: 'done' });
    expect(steps[0]!.doneAt).toBeTruthy();
    await expect(completeStep(k, 'g1', 1)).rejects.toThrow('Step 1 of g1 was already done');
    await expect(completeStep(k, 'g1', 7)).rejects.toThrow('g1 has no step 7');
    expect(await events('step done')).toHaveLength(1);
    // Guard rows never outlive their batch.
    expect(await k.db.select().from(t.writeGuard)).toEqual([]);
  });

  it('refuses a step another device marked done first, and saves nothing', async () => {
    meanwhile(k, () => completeStep(k, 'g1', 2));
    await expect(completeStep(k, 'g1', 2)).rejects.toThrow('Step 2 of g1 was already done');
    expect(await events('step done')).toHaveLength(1);
    expect(await k.db.select().from(t.writeGuard)).toEqual([]);
  });

  it('refuses a step when the goal was closed meanwhile', async () => {
    meanwhile(k, () => closeGoal(k, 'g1', 'dropped'));
    await expect(completeStep(k, 'g1', 1)).rejects.toThrow('g1 is already dropped');
    expect((await findGoal(k, 'g1')).steps[0]!.status).toBe('open');
    await expect(completeStep(k, 'g1', 2)).rejects.toThrow('g1 is already dropped');
  });

  it('lets the first close win', async () => {
    meanwhile(k, () => closeGoal(k, 'g1', 'dropped'));
    await expect(closeGoal(k, 'g1', 'done')).rejects.toThrow('g1 is already dropped');
    expect((await findGoal(k, 'g1')).goal.status).toBe('dropped');
    expect(await events('done')).toHaveLength(0);
    expect(await events('dropped')).toHaveLength(1);
    await expect(closeGoal(k, 'g1', 'dropped')).rejects.toThrow('already dropped');
  });

  it('keeps edits to different fields from two devices', async () => {
    meanwhile(k, () => updateGoal(k, 'g1', { obstacle: 'late meetings' }));
    await updateGoal(k, 'g1', { dueOn: '2026-11-15' });
    expect((await findGoal(k, 'g1')).goal).toMatchObject({ obstacle: 'late meetings', dueOn: '2026-11-15' });
    expect(await events('edited')).toHaveLength(2);
    await expect(updateGoal(k, 'g1', { plan: 'Just run' })).rejects.toThrow('If ..., then');
  });

  it('refuses an edit to a goal deleted meanwhile', async () => {
    meanwhile(k, () => k.db.run(sql`update goals set deleted_at = 'x'`));
    await expect(updateGoal(k, 'g1', { title: 'Run 10 km' })).rejects.toThrow('g1 was deleted on another device');
    expect(await events('edited')).toHaveLength(0);
  });
});
