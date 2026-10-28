import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as t from './db/schema';
import { Conflict, KeelError, NotFound } from './errors';
import { formatStamp } from './dates';
import type { Store } from './store';

// ADR 0004: the goal model. Status changes follow ADR 0003: the first close wins
// (a second `done` or `drop` is refused with what happened), plain fields are last
// arrival wins per field, and every change is recorded in `events`.

export type Goal = typeof t.goals.$inferSelect;
export type GoalStep = typeof t.goalSteps.$inferSelect;
export type GoalStatus = Goal['status'];

export interface GoalView {
  goal: Goal;
  /** In order. Exactly one has `firstStep`. */
  steps: GoalStep[];
}

export interface NewStep {
  text: string;
  /** Local date and time, `2026-10-19T07:00`. */
  cueAt?: string | null;
  cuePlace?: string | null;
  minimum?: string | null;
  firstStep?: boolean;
}

export interface NewGoal {
  title: string;
  doneMeans: string;
  /** `YYYY-MM-DD`. */
  dueOn: string;
  appetite?: string | null;
  obstacle?: string | null;
  plan: string;
  steps: NewStep[];
}

export type GoalFields = Partial<Pick<Goal, 'title' | 'doneMeans' | 'dueOn' | 'appetite' | 'obstacle' | 'plan'>>;

/** "g3" for goal 3. */
export const goalRef = (goal: Pick<Goal, 'refNo'>) => `g${goal.refNo}`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function validDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const blank = (value: string | null | undefined) => !value || !value.trim();

/** Checks the fields a goal can't do without. Throws the first problem, in words. */
export function checkGoalFields(fields: GoalFields, today: string): void {
  if (fields.title !== undefined && blank(fields.title)) throw new KeelError('A goal needs a name.', 'For example: Run 5 km', 'title');
  if (fields.doneMeans !== undefined && blank(fields.doneMeans)) {
    throw new KeelError('Say what done looks like.', 'Something you could check, like "I run 5 km in one go".', 'doneMeans');
  }
  if (fields.dueOn !== undefined) {
    if (!validDay(fields.dueOn)) throw new KeelError(`"${fields.dueOn}" isn't a date.`, 'Use YYYY-MM-DD, like 2026-11-08.', 'dueOn');
    if (fields.dueOn < today) throw new KeelError('The deadline is in the past.', 'Pick a day from today on.', 'dueOn');
  }
  if (fields.plan !== undefined) {
    if (blank(fields.plan)) throw new KeelError('A goal needs an if-then plan.', 'If <the obstacle happens>, then I will <do this>.', 'plan');
    if (!/\bif\b/i.test(fields.plan) || !/\bthen\b/i.test(fields.plan)) {
      throw new KeelError('Write the plan as "If ..., then I will ...".', 'For example: If it is raining at 7:00, then I will do 20 minutes on the treadmill.', 'plan');
    }
  }
}

function checkSteps(steps: NewStep[]): void {
  if (!steps.length) throw new KeelError('A goal needs at least one step.', 'The first one should take under 10 minutes.', 'steps');
  steps.forEach((step, i) => {
    if (blank(step.text)) throw new KeelError(`Step ${i + 1} is empty.`, undefined, 'steps');
    if (step.cueAt && !(CUE.test(step.cueAt) && validDay(step.cueAt.slice(0, 10)))) {
      throw new KeelError(`Step ${i + 1}'s time "${step.cueAt}" isn't a date and time.`, 'Use YYYY-MM-DDTHH:MM, like 2026-10-19T07:00.', 'steps');
    }
  });
  if (steps.filter((s) => s.firstStep).length > 1) throw new KeelError('Only one step can be the first step.', undefined, 'steps');
}

/**
 * Progress, showing the smaller part (Koo and Fishbach 2012): "1 of 4 done"
 * until halfway, then "2 left".
 */
export function progressLabel(steps: Pick<GoalStep, 'status'>[]): string {
  const total = steps.length;
  const done = steps.filter((st) => st.status === 'done').length;
  if (total && done === total) return 'all steps done';
  return done * 2 < total ? `${done} of ${total} done` : `${total - done} left`;
}

const trimmed = (value: string | null | undefined) => (blank(value) ? null : value!.trim());

// ---- reading ----

/** By ref ("g3", "3") or id. Deleted goals are not found. */
export async function findGoal(k: Store, ref: string): Promise<GoalView> {
  const n = /^g?(\d+)$/i.exec(ref.trim());
  const where = n ? eq(t.goals.refNo, Number(n[1])) : eq(t.goals.id, ref);
  const [goal] = await k.db.select().from(t.goals).where(and(where, isNull(t.goals.deletedAt)));
  if (!goal) throw new NotFound(`No goal ${n ? `g${n[1]}` : `"${ref}"`}.`, 'See your goals with: keel goal list');
  return { goal, steps: await stepsOf(k, goal.id) };
}

async function stepsOf(k: Store, goalId: string): Promise<GoalStep[]> {
  return k.db
    .select()
    .from(t.goalSteps)
    .where(and(eq(t.goalSteps.goalId, goalId), isNull(t.goalSteps.deletedAt)))
    .orderBy(asc(t.goalSteps.position));
}

/** Active goals first, nearest deadline first; or only one status. */
export async function listGoals(k: Store, status?: GoalStatus): Promise<GoalView[]> {
  const goals = await k.db
    .select()
    .from(t.goals)
    .where(and(isNull(t.goals.deletedAt), status ? eq(t.goals.status, status) : undefined))
    .orderBy(sql`case ${t.goals.status} when 'active' then 0 else 1 end`, asc(t.goals.dueOn), asc(t.goals.refNo));
  if (!goals.length) return [];
  const steps = await k.db
    .select()
    .from(t.goalSteps)
    .where(and(inArray(t.goalSteps.goalId, goals.map((g) => g.id)), isNull(t.goalSteps.deletedAt)))
    .orderBy(asc(t.goalSteps.position));
  return goals.map((goal) => ({ goal, steps: steps.filter((s) => s.goalId === goal.id) }));
}

// ---- writing ----

export async function createGoal(k: Store, input: NewGoal): Promise<GoalView> {
  const fields = { title: input.title, doneMeans: input.doneMeans, dueOn: input.dueOn, plan: input.plan };
  checkGoalFields(fields, k.today());
  checkSteps(input.steps);
  const id = k.newId();
  const refNo = await k.nextRef(t.goals);
  // Without a mark, the first step in the list is the first step.
  const first = Math.max(0, input.steps.findIndex((s) => s.firstStep));
  await k.batch([
    k.db.insert(t.goals).values({
      id,
      ...k.stamps(),
      refNo,
      title: input.title.trim(),
      doneMeans: input.doneMeans.trim(),
      dueOn: input.dueOn,
      appetite: trimmed(input.appetite),
      obstacle: trimmed(input.obstacle),
      plan: input.plan.trim(),
    }),
    ...input.steps.map((step, i) =>
      k.db.insert(t.goalSteps).values({
        id: k.newId(),
        ...k.stamps(),
        goalId: id,
        position: i + 1,
        text: step.text.trim(),
        cueAt: step.cueAt || null,
        cuePlace: trimmed(step.cuePlace),
        minimum: trimmed(step.minimum),
        firstStep: i === first,
      }),
    ),
    k.event('goal', id, 'created', { ref: `g${refNo}`, title: input.title.trim(), dueOn: input.dueOn, steps: input.steps.length }),
  ]);
  return findGoal(k, id);
}

/** Last arrival wins, per field: only the fields given are written. */
export async function updateGoal(k: Store, ref: string, fields: GoalFields): Promise<GoalView> {
  const { goal } = await findGoal(k, ref);
  checkGoalFields(fields, k.today());
  const set: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(fields) as [keyof GoalFields, string | null | undefined][]) {
    if (value === undefined) continue;
    set[key] = key === 'appetite' || key === 'obstacle' ? trimmed(value) : value!.trim();
  }
  if (!Object.keys(set).length) return findGoal(k, goal.id);
  try {
    await k.batch([
      ...k.guarded(
        k.db
          .update(t.goals)
          .set({ ...set, updatedAt: k.iso() })
          .where(and(eq(t.goals.id, goal.id), isNull(t.goals.deletedAt))),
      ),
      k.event('goal', goal.id, 'edited', { fields: Object.keys(set) }),
    ]);
  } catch (e) {
    if (e instanceof Conflict) throw new Conflict(`${goalRef(goal)} was deleted on another device.`, '');
    throw e;
  }
  return findGoal(k, goal.id);
}

/** Marks a step done. The first close wins: a step done elsewhere, or a closed goal, is refused. */
export async function completeStep(k: Store, ref: string, position: number): Promise<GoalView> {
  const view = await findGoal(k, ref);
  const step = view.steps.find((s) => s.position === position);
  if (!step) throw new NotFound(`${goalRef(view.goal)} has no step ${position}.`, `It has ${view.steps.length}: keel goal show ${goalRef(view.goal)}`);
  refuseClosedGoal(view.goal, k.today());
  if (step.status === 'done') throw alreadyDone(view.goal, step, k.today());
  const at = k.iso();
  try {
    await k.batch([
      ...k.guarded(
        k.db
          .update(t.goalSteps)
          .set({ status: 'done', doneAt: at, updatedAt: at })
          .where(
            and(
              eq(t.goalSteps.id, step.id),
              eq(t.goalSteps.status, 'open'),
              isNull(t.goalSteps.deletedAt),
              // The goal must still be open too, checked in the same statement.
              sql`exists (select 1 from ${t.goals} where ${t.goals.id} = ${view.goal.id} and ${t.goals.status} = 'active' and ${t.goals.deletedAt} is null)`,
            ),
          ),
      ),
      k.event('goal', view.goal.id, 'step done', { position, text: step.text }),
    ]);
  } catch (e) {
    if (!(e instanceof Conflict)) throw e;
    // Say what the other device did.
    const now = await findGoal(k, view.goal.id).catch(() => null);
    if (!now) throw new Conflict(`${goalRef(view.goal)} was deleted on another device.`, '');
    refuseClosedGoal(now.goal, k.today());
    const fresh = now.steps.find((s) => s.id === step.id);
    if (fresh?.status === 'done') throw alreadyDone(now.goal, fresh, k.today());
    throw e;
  }
  return findGoal(k, view.goal.id);
}

/** Closes a goal as done or dropped. The first close wins. */
export async function closeGoal(k: Store, ref: string, outcome: 'done' | 'dropped'): Promise<GoalView> {
  const { goal } = await findGoal(k, ref);
  refuseClosedGoal(goal, k.today());
  const at = k.iso();
  try {
    await k.batch([
      ...k.guarded(
        k.db
          .update(t.goals)
          .set({ status: outcome, closedAt: at, updatedAt: at })
          .where(and(eq(t.goals.id, goal.id), eq(t.goals.status, 'active'), isNull(t.goals.deletedAt))),
      ),
      k.event('goal', goal.id, outcome),
    ]);
  } catch (e) {
    if (!(e instanceof Conflict)) throw e;
    const now = await findGoal(k, goal.id).catch(() => null);
    if (!now) throw new Conflict(`${goalRef(goal)} was deleted on another device.`, '');
    refuseClosedGoal(now.goal, k.today());
    throw e;
  }
  return findGoal(k, goal.id);
}

function refuseClosedGoal(goal: Goal, today: string): void {
  if (goal.status === 'active') return;
  const when = goal.closedAt ? ` on ${formatStamp(goal.closedAt, today)}` : '';
  throw new Conflict(`${goalRef(goal)} is already ${goal.status}${when}.`, 'A closed goal stays closed. Start a new one with: keel goal new');
}

function alreadyDone(goal: Goal, step: GoalStep, today: string): KeelError {
  const when = step.doneAt ? ` on ${formatStamp(step.doneAt, today)}` : '';
  return new Conflict(`Step ${step.position} of ${goalRef(goal)} was already done${when}.`, '');
}
