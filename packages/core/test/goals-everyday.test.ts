import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeGoal, completeStep, createGoal, type NewGoal } from '../src/goals';
import type { Keel } from '../src/keel';
import { renderText } from '../src/render-text';
import { openTestKeel } from './helpers';

// Goals in today, the weekly review, the summary, and export and import (ADR 0004).

// Monday 12 October 2026, 09:00 local time.
let now: Date;
let keel: Keel;
const run = async (line: string) => renderText(await keel.run(line));
const data = async (line: string) => {
  const block = (await keel.exec(`${line} --json`)).blocks[0];
  if (block?.kind !== 'raw') throw new Error(`expected raw JSON, got ${JSON.stringify(block)}`);
  return (JSON.parse(block.text) as { data: any }).data;
};

/** Runs an interactive command, answering each question in order. */
async function play(line: string, answers: string[], before?: (prompt: string) => Promise<void>) {
  let result = await keel.exec(line);
  const out = [renderText(result.blocks)];
  while (result.question && result.session) {
    if (answers.length === 0) throw new Error(`No answer left for "${result.question.prompt}"`);
    await before?.(result.question.prompt);
    result = await keel.answer(result.session, answers.shift()!);
    out.push(renderText(result.blocks));
  }
  return out.join('\n');
}

const goal = (over: Partial<NewGoal> = {}): NewGoal => ({
  title: 'Run 5 km',
  doneMeans: 'I run 5 km in one go',
  dueOn: '2026-11-08',
  appetite: null,
  obstacle: 'rainy mornings',
  plan: 'If it rains, then I will use the treadmill.',
  steps: [{ text: 'Run 1 km', cueAt: '2026-10-12T07:00', cuePlace: 'the park', minimum: '10 minutes' }, { text: 'Run 2 km', cueAt: '2026-10-17T07:00' }, { text: 'Run 5 km' }],
  ...over,
});

const dir = mkdtempSync(join(tmpdir(), 'keel-goals-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(async () => {
  now = new Date(2026, 9, 12, 9, 0);
  keel = await openTestKeel(() => now);
  await run('client new acme "Acme Corp"');
  await run('project new acme/website "Website rebuild"');
});

afterEach(() => keel.close());

describe('today', () => {
  it('shows each active goal with its next step and cue', async () => {
    await createGoal(keel.store, goal());
    const text = await run('today');
    expect(text).toContain('GOALS');
    expect(text).toMatch(/g1\s+Run 5 km\s+0 of 3 done/);
    expect(text).toContain('next: Run 1 km · today 07:00 · the park');

    await completeStep(keel.store, 'g1', 1);
    expect(await run('today')).toContain('next: Run 2 km · Sat 07:00');
    expect((await data('today')).goals.map((g: { ref: string }) => g.ref)).toEqual(['g1']);
  });

  it('says how to close a goal whose steps are all done, and leaves closed goals out', async () => {
    await createGoal(keel.store, goal({ steps: [{ text: 'Run 1 km' }] }));
    await createGoal(keel.store, goal({ title: 'Read a book' }));
    await completeStep(keel.store, 'g1', 1);
    await closeGoal(keel.store, 'g2', 'dropped');
    const text = await run('today');
    expect(text).toContain('all steps done · close it with goal done g1');
    expect(text).not.toContain('Read a book');
  });

  it('leaves goals out of a +client view, and the section out when there are none', async () => {
    expect(await run('today')).not.toContain('GOALS');
    await createGoal(keel.store, goal());
    expect(await run('today +acme')).not.toContain('GOALS');
    expect((await data('today +acme')).goals).toEqual([]);
  });
});

describe('weekly review', () => {
  it('goes through each goal: keep going, close or drop', async () => {
    await createGoal(keel.store, goal());
    await createGoal(keel.store, goal({ title: 'Read a book', dueOn: '2026-11-20' }));
    await completeStep(keel.store, 'g1', 1);
    now = new Date(2026, 9, 16, 15, 0); // Friday afternoon

    const text = await play('review', [
      'maybe', // g1: not an option, asked again
      'done', // g1
      'Ran 5 km a week late', // what happened
      'Two rainy weeks', // why
      'Plan the treadmill earlier', // next time
      'drop', // g2
      '', // three questions skipped
      '',
      '',
      'ok', // acme/website
      '', // acme priority
    ]);
    expect(text).toContain('STEP 4 OF 7 · GOALS');
    expect(text).toMatch(/g1\s+Run 5 km\s+1 done this week/);
    expect(text).toContain('"maybe" isn\'t an option.');
    expect(text).toContain('Planned 27 days, took 4: 23 days early.');
    expect(text).toContain('g1 Run 5 km is done.');
    expect(text).toContain('g2 Read a book dropped.');
    expect(await run('goal show g1')).toMatch(/REVIEW[\s\S]*happened\s+Ran 5 km a week late[\s\S]*next time\s+Plan the treadmill earlier/);
    expect(text).toContain('STEP 7 OF 7');
    expect(await run('goals')).toContain('No active goals');
  });

  it('says so when another device closed the goal first, and carries on', async () => {
    await createGoal(keel.store, goal());
    const text = await play('review', ['done', 'ok', ''], async (prompt) => {
      if (prompt === 'Still on track?') await closeGoal(keel.store, 'g1', 'dropped');
    });
    expect(text).toMatch(/g1 is already dropped|already closed|was dropped/i);
    expect(text).toContain('Review done');
  });

  it('skips every goal when run without answers', async () => {
    await createGoal(keel.store, goal());
    const text = await run('review');
    expect(text).toContain('Review done');
    expect(await run('goals')).toContain('Run 5 km');
  });
});

describe('summary', () => {
  it('counts the steps done in the period, and leaves goals out of a +client summary', async () => {
    await createGoal(keel.store, goal());
    await completeStep(keel.store, 'g1', 1);
    await completeStep(keel.store, 'g1', 2);
    const text = await run('summary week');
    expect(text).toContain('GOALS');
    expect(text).toMatch(/g1\s+Run 5 km\s+2 steps done/);
    expect((await data('summary week')).goals).toEqual([{ ref: 'g1', title: 'Run 5 km', status: 'active', stepsDone: 2, progress: '1 left' }]);
    expect(await run('summary week +acme')).not.toContain('GOALS');

    now = new Date(2026, 9, 19, 9, 0); // next Monday: nothing done this week yet
    expect(await run('summary week')).toMatch(/g1\s+Run 5 km\s+0 steps done/);
  });
});

describe('export and import', () => {
  it('carries goals and their steps through a JSON export', async () => {
    await createGoal(keel.store, goal());
    await completeStep(keel.store, 'g1', 1);
    const before = JSON.parse(await run('export'));
    expect(before.version).toBe(2);
    expect(before.data.goals).toHaveLength(1);
    expect(before.data.goalSteps).toHaveLength(3);
    const file = join(dir, 'with-goals.json');
    writeFileSync(file, JSON.stringify(before));

    keel.close();
    keel = await openTestKeel(() => now);
    expect(await run(`import ${file}`)).toContain('0 resume notes, 1 goal');
    expect(JSON.parse(await run('export')).data).toEqual(before.data);
    expect(await run('goal show g1')).toContain('1 of 3 done');
    expect(await run('goal new "Read a book" done:"last page" due:+3w obstacle:"tired" plan:"If tired, then I will read 2 pages" step:"pick it"')).toContain('g2');
  });

  it('still imports a version 1 export, and refuses one from a newer Keel', async () => {
    const old = JSON.parse(await run('export'));
    const v1 = join(dir, 'v1.json');
    writeFileSync(v1, JSON.stringify({ ...old, version: 1, data: { ...old.data, goals: undefined, goalSteps: undefined } }));
    const v3 = join(dir, 'v3.json');
    writeFileSync(v3, JSON.stringify({ ...old, version: 3 }));

    keel.close();
    keel = await openTestKeel(() => now);
    expect(await run(`import ${v3}`)).toContain('reads export versions 1 to 2, and the file is version 3');
    expect(await run(`import ${v1}`)).toContain('Imported 1 client, 1 project');
  });

  it('writes goals into the Markdown export', async () => {
    await createGoal(keel.store, goal());
    await completeStep(keel.store, 'g1', 1);
    const md = await run('export --md');
    expect(md).toContain('## Goals');
    expect(md).toContain('### g1 Run 5 km · due 2026-11-08 · active');
    expect(md).toContain('- Plan: If it rains, then I will use the treadmill.');
    expect(md).toContain('1. [x] Run 1 km · 2026-10-12 07:00 · the park · or 10 minutes');
    expect(md).toContain('3. [ ] Run 5 km');
  });
});
