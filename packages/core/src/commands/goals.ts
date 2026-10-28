import { blank, data, fail, heading, hint, line, ok, s, table, warn, type Block, type Question, type Span } from '../blocks';
import { describeDue, formatDay, parseCue, parseDue } from '../dates';
import { KeelError } from '../errors';
import { checkGoalFields, closeGoal, completeStep, createGoal, findGoal, goalRef, listGoals, progressLabel, type GoalStep, type GoalView, type NewStep } from '../goals';
import type { Parsed } from '../parse';
import type { Store } from '../store';
import { goalData, type Command, type Flow } from './shared';

// ADR 0004: `goal new` asks for what a goal can't do without (what done means, a
// deadline, the obstacle and an if-then plan, then steps with cues). Anything given
// inline as key:value is not asked, so `--json` works when the required keys are there.

const KEYS = ['done', 'due', 'time', 'obstacle', 'plan', 'step'] as const;
type Key = (typeof KEYS)[number];
const MAX_STEPS = 20;
const SKIP = 'enter on an empty line skips';

export const goal: Command = {
  name: 'goal',
  usage: 'goal new "<name>" [done:"..."] [due:<when>] [time:"..."] [obstacle:"..."] [plan:"If ..., then I will ..."] [step:"..."] | goals [--all] | goal show|done|drop <g1> | goal step done <g1> <n>',
  summary: 'Set one small goal with steps and an if-then plan, then finish it',
  async *flow(k, p) {
    const sub = (p.words[0] ?? 'ls').toLowerCase();
    if (sub === 'new') return yield* newGoal(k, p);
    if (sub === 'ls' || sub === 'list') return listBlocks(k, p.flags.has('all'));
    if (sub === 'show') return showGoal(k, goalArg(p.words[1], 'show'));
    if (sub === 'done' || sub === 'drop') return closeBlocks(k, goalArg(p.words[1], sub), sub === 'done' ? 'done' : 'dropped');
    if (sub === 'step') return stepDone(k, p);
    throw new KeelError(`Unknown "goal ${sub}".`, 'Try: goal new, goals, goal show g1, goal step done g1 2, goal done g1, goal drop g1');
  },
};

function goalArg(word: string | undefined, sub: string): string {
  if (!word || !/^g?\d+$/i.test(word)) throw new KeelError('Which goal?', `Example: goal ${sub} g1. See your goals with: goals`);
  return word;
}

// ---- goal new ----

/** The title and key:value parts of `goal new ...`. `step:` can repeat. */
function inline(p: Parsed): { title: string; fields: Partial<Record<Exclude<Key, 'step'>, string>>; steps: string[] } {
  const fields: Partial<Record<Exclude<Key, 'step'>, string>> = {};
  const steps: string[] = [];
  const title: string[] = [];
  let sawNew = false;
  for (const tok of p.raw) {
    if (!sawNew && !tok.quoted && tok.text.toLowerCase() === 'new') {
      sawNew = true;
      continue;
    }
    if (!tok.quoted && /^--[a-z][\w-]*$/.test(tok.text)) continue;
    const kv = tok.quoted ? null : /^([a-z]+):(.*)$/s.exec(tok.text);
    const key = kv?.[1] as Key | undefined;
    if (kv && key && (KEYS as readonly string[]).includes(key)) {
      if (key === 'step') steps.push(kv[2] ?? '');
      else fields[key] = kv[2] ?? '';
      continue;
    }
    title.push(tok.text);
  }
  return { title: title.join(' ').trim(), fields, steps };
}

/**
 * Asks until `read` accepts the answer. A wrong answer is asked again; an empty one
 * that `read` refuses (a required field) stops the command, with how to give it inline.
 */
async function* ask<T>(question: Question, read: (answer: string) => T, key: Key | null, blocks: Block[] = []): Flow<T> {
  let shown = blocks;
  for (;;) {
    const answer = (yield { blocks: shown, question }).trim();
    try {
      return read(answer);
    } catch (e) {
      if (!(e instanceof KeelError)) throw e;
      if (!answer) throw key ? new KeelError(e.message, `${e.hint ? `${e.hint} ` : ''}Or add ${key}:"..." to the command.`) : e;
      shown = [fail(e.message), ...(e.hint ? [hint(e.hint)] : [])];
    }
  }
}

/** Uses the inline value when there is one (a wrong one stops the command), else asks. */
async function* field<T>(given: string | undefined, question: Question, read: (answer: string) => T, key: Key | null, blocks: Block[] = []): Flow<T> {
  if (given !== undefined) return read(given.trim());
  return yield* ask(question, read, key, blocks);
}

async function* newGoal(k: Store, p: Parsed): Flow {
  const given = inline(p);
  const today = k.today();
  const check = (fields: Parameters<typeof checkGoalFields>[0]) => checkGoalFields(fields, today);

  const title = yield* field(given.title || undefined, { prompt: 'What is the goal?', hint: 'Small and finishable, like: Run 5 km' }, (a) => (check({ title: a }), a), null);
  const intro = [line([s('◆ ', 'accent'), s('New goal: '), s(title, 'default', { bold: true })])];
  const doneMeans = yield* field(given.fields.done, { prompt: 'What does done look like?', hint: 'Something you could check, like: I run 5 km in one go' }, (a) => (check({ doneMeans: a }), a), 'done', intro);
  const dueOn = yield* field(
    given.fields.due,
    { prompt: 'Deadline?', hint: 'like nov 8, +3w or 2026-11-08' },
    (a) => {
      if (!a) throw new KeelError('When is the deadline?', 'Examples: nov 8, +3w, 2026-11-08.');
      const day = parseDue(a, k.now());
      if (!day) throw new KeelError(`Can't read the date "${a}".`, 'Examples: nov 8, +3w, 2026-11-08.');
      check({ dueOn: day });
      return day;
    },
    'due',
  );
  const appetite = yield* field(given.fields.time, { prompt: 'How much time will you give it?', hint: `like 30 minutes a day · ${SKIP}` }, (a) => a || null, 'time');
  const obstacle = yield* field(
    given.fields.obstacle,
    { prompt: 'What could get in the way?', hint: 'One thing, like: rainy mornings' },
    (a) => {
      if (!a) throw new KeelError('Name one thing that could get in the way.', 'For example: rainy mornings.');
      return a;
    },
    'obstacle',
  );
  const plan = yield* field(
    given.fields.plan,
    { prompt: 'Your if-then plan?', hint: `If ${obstacle}, then I will ...` },
    (a) => (check({ plan: a }), a),
    'plan',
  );

  const steps: NewStep[] = given.steps.length ? given.steps.map((text) => ({ text })) : yield* askSteps(k);
  const view = await createGoal(k, { title, doneMeans, dueOn, appetite, obstacle, plan, steps });
  const ref = goalRef(view.goal);
  const first = view.steps.find((st) => st.firstStep)!;
  return [
    ok([s(ref, 'default', { bold: true, ref }), s(` ${view.goal.title}`), s(` · ${formatDay(dueOn, today)}`), s(` · ${view.steps.length} step${view.steps.length === 1 ? '' : 's'}`)]),
    hint(`First step: ${first.text}. When it's done: goal step done ${ref} ${first.position}`),
    data(goalData(view)),
  ];
}

/** Step text, then its cue and smaller version, until an empty line. */
async function* askSteps(k: Store): Flow<NewStep[]> {
  const steps: NewStep[] = [];
  for (let n = 1; n <= MAX_STEPS; n++) {
    const text = yield* ask(
      n === 1 ? { prompt: 'Step 1?', hint: 'Make the first one take under 10 minutes, like: put my shoes by the door' } : { prompt: `Step ${n}?`, hint: 'enter on an empty line finishes' },
      (a) => {
        if (!a && n === 1) throw new KeelError('A goal needs at least one step.', 'The first one should take under 10 minutes.');
        return a;
      },
      n === 1 ? 'step' : null,
    );
    if (!text) break;
    const cue = yield* ask(
      { prompt: 'When and where?', hint: `like sat 7:00 at the park · ${SKIP}` },
      (a) => {
        if (!a) return { at: null, place: null };
        const found = parseCue(a, k.now());
        if (found.at === undefined) throw new KeelError('Add a time to that day.', 'For example: sat 7:00 at the park.');
        if (found.at && found.at < `${k.today()}T00:00`) throw new KeelError('That time has passed.', 'Pick a time from now on.');
        return found;
      },
      null,
    );
    const minimum = yield* ask({ prompt: 'A smaller version for a bad day?', hint: `like 10 minutes · ${SKIP}` }, (a) => a || null, null);
    steps.push({ text, cueAt: cue.at ?? null, cuePlace: cue.place, minimum });
  }
  return steps;
}

// ---- goals, goal show ----

function dueSpan(view: GoalView, today: string): Span {
  if (view.goal.status !== 'active') return s(view.goal.status, view.goal.status === 'done' ? 'done' : 'dim');
  const due = describeDue(view.goal.dueOn, today);
  return s(due.text, due.tone);
}

async function listBlocks(k: Store, all: boolean): Promise<Block[]> {
  const views = await listGoals(k);
  const shown = all ? views : views.filter((v) => v.goal.status === 'active');
  const closed = views.length - shown.length;
  if (!shown.length) {
    return [
      hint(views.length ? `No active goals. ${closed} closed: goals --all` : 'No goals yet. Start one: goal new "Run 5 km"'),
      data({ goals: [] }),
    ];
  }
  const day = k.today();
  return [
    heading(`GOALS · ${shown.length}`),
    table(
      shown.map((v) => {
        const ref = goalRef(v.goal);
        return [s(ref, 'muted', { ref }), s(v.goal.title), s(progressLabel(v.steps), 'muted'), dueSpan(v, day)];
      }),
    ),
    ...(closed ? [hint(`${closed} closed. Show them with: goals --all`)] : []),
    data({ goals: shown.map(goalData) }),
  ];
}

function cueText(step: GoalStep, today: string): string {
  const when = step.cueAt ? `${formatDay(step.cueAt.slice(0, 10), today)} ${step.cueAt.slice(11)}` : '';
  return [when, step.cuePlace ?? ''].filter(Boolean).join(' · ');
}

function stepRow(step: GoalStep, today: string): Span[] {
  const done = step.status === 'done';
  const cue = cueText(step, today);
  return [
    s(String(step.position), 'muted'),
    s(done ? '✓' : '○', done ? 'done' : 'muted'),
    s(step.text, done ? 'dim' : 'default'),
    cue ? s(cue, 'muted') : s('-', 'dim'),
    ...(step.minimum ? [s(`or ${step.minimum}`, 'dim')] : []),
    ...(step.firstStep && !done ? [s('first step', 'accent')] : []),
  ];
}

/** What to do next with a goal, as a hint. */
function nextHint(view: GoalView): Block[] {
  if (view.goal.status !== 'active') return [];
  const ref = goalRef(view.goal);
  const next = view.steps.find((st) => st.status === 'open');
  return [hint(next ? `Next: ${next.text}. When it's done: goal step done ${ref} ${next.position}` : `All steps done. Close it with: goal done ${ref}`)];
}

export async function showGoal(k: Store, ref: string): Promise<Block[]> {
  const view = await findGoal(k, ref);
  const { goal } = view;
  const day = k.today();
  const due = dueSpan(view, day);
  return [
    line([s(`${goalRef(goal)}  `, 'muted'), s(goal.title, 'default', { bold: true })]),
    table(
      [
        [s('done means', 'muted'), s(goal.doneMeans)],
        // "Sun 8 Nov", plus "tomorrow" or "2d late" when the short form says more.
        [s('deadline', 'muted'), s(formatDay(goal.dueOn, day)), ...(goal.status === 'active' && due.text !== formatDay(goal.dueOn, day) ? [due] : [])],
        ...(goal.appetite ? [[s('time', 'muted'), s(goal.appetite)]] : []),
        ...(goal.obstacle ? [[s('obstacle', 'muted'), s(goal.obstacle)]] : []),
        [s('plan', 'muted'), s(goal.plan)],
        [s('status', 'muted'), goal.status === 'active' ? s(progressLabel(view.steps)) : due],
      ],
      2,
    ),
    blank(),
    heading('STEPS', 'muted'),
    table(view.steps.map((st) => stepRow(st, day))),
    ...nextHint(view),
    data(goalData(view)),
  ];
}

// ---- goal done, goal drop, goal step done ----

async function closeBlocks(k: Store, ref: string, outcome: 'done' | 'dropped'): Promise<Block[]> {
  const view = await closeGoal(k, ref, outcome);
  const open = view.steps.filter((st) => st.status === 'open').length;
  const r = goalRef(view.goal);
  return [
    outcome === 'done' ? ok([s(r, 'default', { bold: true, ref: r }), s(` ${view.goal.title} is done.`)]) : warn([s(r, 'default', { bold: true, ref: r }), s(` ${view.goal.title} dropped.`)]),
    ...(open ? [hint(`${open} step${open === 1 ? ' was' : 's were'} still open.`)] : []),
    data(goalData(view)),
  ];
}

async function stepDone(k: Store, p: Parsed): Promise<Block[]> {
  const usage = 'Example: goal step done g1 2';
  if ((p.words[1] ?? '').toLowerCase() !== 'done') throw new KeelError('Mark which step done?', usage);
  const ref = goalArg(p.words[2], 'step done');
  const position = Number(p.words[3]);
  if (!Number.isInteger(position) || position < 1) throw new KeelError('Which step? Give its number.', `${usage}. See the steps with: goal show ${ref}`);
  const view = await completeStep(k, ref, position);
  const step = view.steps.find((st) => st.position === position)!;
  const r = goalRef(view.goal);
  return [
    ok([s(`Step ${position} of `), s(r, 'default', { bold: true, ref: r }), s(` done · ${step.text}`), s(` · ${progressLabel(view.steps)}`, 'muted')]),
    ...nextHint(view),
    data(goalData(view)),
  ];
}
