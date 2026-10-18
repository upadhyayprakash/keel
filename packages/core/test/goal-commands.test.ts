import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCue } from '../src/dates';
import { progressLabel } from '../src/goals';
import type { Keel } from '../src/keel';
import { renderText } from '../src/render-text';
import { openTestKeel } from './helpers';

// Monday 12 October 2026, 09:00 local time.
const now = () => new Date(2026, 9, 12, 9, 0);
let keel: Keel;
const run = async (line: string) => renderText(await keel.run(line));
const json = async (line: string) => {
  const block = (await keel.exec(line)).blocks[0];
  if (block?.kind !== 'raw') throw new Error(`expected raw JSON, got ${JSON.stringify(block)}`);
  return JSON.parse(block.text) as { ok: boolean; data: any; error?: string; hint?: string | null };
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

const INLINE = 'goal new "Run 5 km" done:"I run 5 km in one go" due:2026-11-08 obstacle:"rainy mornings" plan:"If it rains at 7:00, then I will use the treadmill"';

beforeEach(async () => {
  keel = await openTestKeel(now);
});

afterEach(() => keel.close());

describe('progressLabel', () => {
  const steps = (done: number, total: number) => Array.from({ length: total }, (_, i) => ({ status: i < done ? ('done' as const) : ('open' as const) }));

  it('shows the smaller part: done before halfway, left after', () => {
    expect(progressLabel(steps(1, 12))).toBe('1 of 12 done');
    expect(progressLabel(steps(5, 12))).toBe('5 of 12 done');
    expect(progressLabel(steps(6, 12))).toBe('6 left');
    expect(progressLabel(steps(10, 12))).toBe('2 left');
    expect(progressLabel(steps(3, 3))).toBe('all steps done');
  });
});

describe('parseCue', () => {
  it('reads a day, a time and a place', () => {
    expect(parseCue('sat 7:00 at the park', now())).toEqual({ at: '2026-10-17T07:00', place: 'the park' });
    expect(parseCue('tomorrow 6:30pm', now())).toEqual({ at: '2026-10-13T18:30', place: null });
    expect(parseCue('at the gym', now())).toEqual({ at: null, place: 'the gym' });
  });

  it('flags a day without a time', () => {
    expect(parseCue('saturday', now()).at).toBeUndefined();
  });
});

describe('goal new', () => {
  it('asks for each field, then steps with cues, until an empty step', async () => {
    const { text, questions } = await play('goal new "Run 5 km"', [
      'I run 5 km in one go',
      'nov 8',
      '3 runs a week',
      'rainy mornings',
      'If it rains at 7:00, then I will use the treadmill',
      'Put my shoes by the door',
      'sat 7:00 at the park',
      '',
      'Run 1 km',
      '',
      '10 minutes',
      '',
    ]);
    expect(questions.slice(0, 7)).toEqual([
      'What does done look like?',
      'Deadline?',
      'How much time will you give it?',
      'What could get in the way?',
      'Your if-then plan?',
      'Step 1?',
      'When and where?',
    ]);
    expect(questions.at(-1)).toBe('Step 3?');
    expect(text).toContain('◆ New goal: Run 5 km');
    expect(text).toContain('g1 Run 5 km · Sun 8 Nov · 2 steps');
    expect(text).toContain('First step: Put my shoes by the door. When it\'s done: goal step done g1 1');

    const g = (await json('goal show g1 --json')).data;
    expect(g).toMatchObject({ ref: 'g1', appetite: '3 runs a week', dueOn: '2026-11-08', progress: { done: 0, total: 2 } });
    expect(g.steps).toMatchObject([
      { position: 1, text: 'Put my shoes by the door', cueAt: '2026-10-17T07:00', cuePlace: 'the park', minimum: null, firstStep: true },
      { position: 2, text: 'Run 1 km', cueAt: null, minimum: '10 minutes', firstStep: false },
    ]);
  });

  it('asks again after a wrong answer', async () => {
    const { text, questions } = await play('goal new "Run 5 km" done:"5 km in one go" obstacle:rain', [
      'someday maybe',
      'nov 8',
      '',
      'treadmill when it rains',
      'If it rains, then I will use the treadmill',
      'Run 1 km',
      'saturday',
      'sat 7:00',
      '',
      '',
    ]);
    expect(questions.filter((q) => q === 'Deadline?')).toHaveLength(2);
    expect(questions.filter((q) => q === 'Your if-then plan?')).toHaveLength(2);
    expect(questions.filter((q) => q === 'When and where?')).toHaveLength(2);
    expect(text).toContain('Write the plan as "If ..., then I will ...".');
    expect(text).toContain('Add a time to that day.');
    expect(text).toContain('g1 Run 5 km');
  });

  it('skips what is given inline, and steps given inline skip the step questions', async () => {
    const { questions } = await play(`${INLINE} step:"Run 1 km" step:"Run 3 km"`, ['']);
    expect(questions).toEqual(['How much time will you give it?']);
    expect((await json('goal show g1 --json')).data.steps.map((st: { text: string }) => st.text)).toEqual(['Run 1 km', 'Run 3 km']);
  });

  it('stops on an empty required answer and says how to give it inline', async () => {
    const { text } = await play('goal new "Run 5 km"', ['']);
    expect(text).toContain('Say what done looks like.');
    expect(text).toContain('Or add done:"..." to the command.');
    expect(await run('goals')).toContain('No goals yet');
  });

  it('works with --json when the required keys are there, and fails cleanly when not', async () => {
    const out = await json(`${INLINE} step:"Run 1 km" --json`);
    expect(out.ok).toBe(true);
    expect(out.data).toMatchObject({ ref: 'g1', title: 'Run 5 km', status: 'active', appetite: null, steps: [{ text: 'Run 1 km', firstStep: true }] });

    expect(await json(`${INLINE} --json`)).toMatchObject({ ok: false, error: 'A goal needs at least one step.' });
    expect(await json('goal new "Run 5 km" done:x due:2026-01-01 obstacle:x plan:"If x, then y" step:a --json')).toMatchObject({ ok: false, error: 'The deadline is in the past.' });
  });
});

describe('goals, goal show, step done, done and drop', () => {
  beforeEach(async () => {
    await run(`${INLINE} step:"Run 1 km" step:"Run 3 km" step:"Run 5 km"`);
  });

  it('lists active goals with progress, and closed ones with --all', async () => {
    await run('goal new "Read a book" done:"last page" due:+2w obstacle:"tired evenings" plan:"If I am tired, then I will read 2 pages" step:"pick the book"');
    expect(await run('goals')).toMatch(/g1\s+Run 5 km\s+0 of 3 done\s+Sun 8 Nov/);
    await run('goal drop g2');
    const active = await run('goals');
    expect(active).not.toContain('Read a book');
    expect(active).toContain('1 closed. Show them with: goals --all');
    expect(await run('goals --all')).toMatch(/g2\s+Read a book\s+0 of 1 done\s+dropped/);
    expect((await json('goal ls --json')).data.goals.map((g: { ref: string }) => g.ref)).toEqual(['g1']);
  });

  it('marks steps done in order of the hints, then closes the goal', async () => {
    expect(await run('goal step done g1 1')).toContain('Step 1 of g1 done · Run 1 km · 1 of 3 done');
    const second = await run('goal step done g1 2');
    expect(second).toContain('1 left');
    expect(second).toContain("Next: Run 5 km. When it's done: goal step done g1 3");
    expect(await run('goal step done g1 3')).toContain('All steps done. Close it with: goal done g1');
    expect(await run('goal step done g1 3')).toContain('Step 3 of g1 was already done');
    expect(await run('goal done g1')).toContain('g1 Run 5 km is done.');
    expect(await run('goal drop g1')).toContain('g1 is already done');
    expect((await json('goal show g1 --json')).data).toMatchObject({ status: 'done', progress: { done: 3, total: 3 } });
  });

  it('refuses steps on a closed goal, and says what was still open', async () => {
    const dropped = await run('goal drop g1');
    expect(dropped).toContain('g1 Run 5 km dropped.');
    expect(dropped).toContain('3 steps were still open.');
    expect(await run('goal step done g1 1')).toContain('g1 is already dropped');
  });

  it('shows the goal with its steps, also as show g1', async () => {
    const shown = await run('show g1');
    expect(shown).toContain('done means  I run 5 km in one go');
    expect(shown).toContain('plan        If it rains at 7:00, then I will use the treadmill');
    expect(shown).toMatch(/1\s+○\s+Run 1 km\s+-\s+first step/);
    expect(await run('goal show g1')).toBe(shown);
  });

  it('explains bad references', async () => {
    expect(await run('goal show')).toContain('Which goal?');
    expect(await run('goal show g9')).toContain('No goal g9.');
    expect(await run('goal step done g1')).toContain('Which step? Give its number.');
    expect(await run('goal step done g1 7')).toContain('g1 has no step 7.');
    expect(await run('goal step g1 1')).toContain('Mark which step done?');
    expect(await run('goal finish g1')).toContain('Unknown "goal finish".');
  });
});

describe('goal autocomplete', () => {
  const inserts = async (line: string) => (await keel.complete(line)).suggestions.map((x) => x.insert);

  beforeEach(async () => {
    await run(`${INLINE} step:"Run 1 km" step:"Run 3 km"`);
    await run('goal new "Old goal" done:x due:+1w obstacle:x plan:"If x, then y" step:a');
    await run('goal done g2');
    await run('goal step done g1 1');
  });

  it('offers subcommands, active goals and open steps', async () => {
    expect(await inserts('goal ')).toEqual(['new', 'ls', 'show', 'step', 'done', 'drop']);
    expect(await inserts('goal step ')).toEqual(['done']);
    expect(await inserts('goal step done ')).toEqual(['g1']);
    expect(await inserts('goal step done g1 ')).toEqual(['2']);
    expect(await inserts('goal done ')).toEqual(['g1']);
    expect(await inserts('goal show ')).toEqual(['g1', 'g2']);
    expect(await inserts('show g')).toEqual(['g1']);
    expect(await inserts('go')).toEqual(['goal', 'goals']);
  });

  it('offers the keys of goal new', async () => {
    expect(await inserts('goal new "Run" pl')).toEqual(['plan:']);
    expect(await inserts('goal new "Run" st')).toEqual(['step:']);
    expect(await inserts('goal new "Run" due:2026-11-08 du')).toEqual([]);
  });
});
