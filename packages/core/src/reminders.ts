import { and, eq, gt, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import * as t from './db/schema';
import { ymd } from './dates';
import { goalRef, type Goal, type GoalStep } from './goals';
import type { Store } from './store';

// ADR 0004, section 5: cue reminders. `keel serve` asks each minute which cues are
// due. A cue at most 5 minutes old gets its own push; older ones (the server was
// down, the laptop slept) go out together as one catch-up push, for the last 12
// hours only. A step still open when its cue's day ends is a missed cue; the goal
// counts misses in a row until a step is done, and 2 or more is flagged.

const MINUTE = 60_000;
/** A cue older than this is sent as a catch-up. */
export const ON_TIME = 5 * MINUTE;
/** Cues older than this are never sent. */
export const CATCH_UP_WINDOW = 12 * 60 * MINUTE;

const pad = (n: number) => String(n).padStart(2, '0');
/** Local date and time in the `cueAt` form, `2026-10-19T07:00`. */
export const cueStamp = (d: Date) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export interface DueCue {
  goal: Goal;
  step: GoalStep;
  /** True when it is older than ON_TIME, so it goes into the catch-up push. */
  late: boolean;
}

/** What the Goals service worker shows (the same shape as the server's PushMessage). */
export interface ReminderMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
  actions?: Array<{ action: 'done' | 'fallback'; title: string }>;
  data: { kind: 'cue' | 'catch-up'; goal?: string; position?: number; cueAt?: string };
}

/** Open steps of active goals whose cue has come in the last 12 hours and has had no reminder yet. */
export async function dueCues(k: Store): Promise<DueCue[]> {
  const now = k.now();
  const until = cueStamp(now);
  const from = cueStamp(new Date(now.getTime() - CATCH_UP_WINDOW));
  const onTimeFrom = cueStamp(new Date(now.getTime() - ON_TIME));
  const rows = await k.db
    .select({ goal: t.goals, step: t.goalSteps })
    .from(t.goalSteps)
    .innerJoin(t.goals, eq(t.goals.id, t.goalSteps.goalId))
    .where(
      and(
        eq(t.goalSteps.status, 'open'),
        isNull(t.goalSteps.deletedAt),
        eq(t.goals.status, 'active'),
        isNull(t.goals.deletedAt),
        isNotNull(t.goalSteps.cueAt),
        gt(t.goalSteps.cueAt, from),
        lte(t.goalSteps.cueAt, until),
        or(isNull(t.goalSteps.cuePushedFor), ne(t.goalSteps.cuePushedFor, t.goalSteps.cueAt)),
        or(isNull(t.goalSteps.missedCueAt), ne(t.goalSteps.missedCueAt, t.goalSteps.cueAt)),
      ),
    )
    .orderBy(t.goalSteps.cueAt, t.goalSteps.position);
  return rows.map(({ goal, step }) => ({ goal, step, late: step.cueAt! < onTimeFrom }));
}

const time = (cueAt: string) => cueAt.slice(11);
const goalUrl = (goal: Goal) => `/goals/${goalRef(goal)}`;

function stepActions(step: GoalStep): ReminderMessage['actions'] {
  return [{ action: 'done', title: 'Done' }, ...(step.minimum ? [{ action: 'fallback' as const, title: 'Do the fallback' }] : [])];
}

const stepData = (kind: 'cue' | 'catch-up', { goal, step }: DueCue): ReminderMessage['data'] => ({ kind, goal: goalRef(goal), position: step.position, cueAt: step.cueAt! });

/** One push per on-time cue, plus one catch-up push for all the late ones. */
export function reminderMessages(due: DueCue[], today: string): ReminderMessage[] {
  const onTime = due.filter((d) => !d.late);
  const late = due.filter((d) => d.late);
  const messages: ReminderMessage[] = onTime.map((d) => ({
    title: d.step.text,
    body: `${time(d.step.cueAt!)}${d.step.cuePlace ? ` at ${d.step.cuePlace}` : ''}, for ${d.goal.title}.`,
    url: goalUrl(d.goal),
    tag: `keel-cue-${goalRef(d.goal)}-${d.step.position}`,
    actions: stepActions(d.step),
    data: stepData('cue', d),
  }));
  if (late.length === 1) {
    const d = late[0]!;
    const sameDay = d.step.cueAt!.slice(0, 10) === today;
    messages.push({
      title: `You planned ${d.step.text} at ${time(d.step.cueAt!)}`,
      body: d.step.minimum ? `Do the smaller version instead: ${d.step.minimum}.` : sameDay ? 'There is still time today.' : 'Plan it again in Goals.',
      url: goalUrl(d.goal),
      tag: 'keel-catch-up',
      actions: stepActions(d.step),
      data: stepData('catch-up', d),
    });
  } else if (late.length > 1) {
    const named = late.slice(0, 3).map((d) => `${d.step.text} at ${time(d.step.cueAt!)}`);
    const more = late.length - named.length;
    messages.push({
      title: `You missed ${late.length} planned steps`,
      body: `${named.join(', ')}${more ? `, and ${more} more` : ''}.`,
      url: '/goals/',
      tag: 'keel-catch-up',
      data: { kind: 'catch-up' },
    });
  }
  return messages;
}

/** Records that these cues had their reminder, so none is sent twice. */
export async function markCuesPushed(k: Store, due: DueCue[]): Promise<void> {
  if (!due.length) return;
  const at = k.iso();
  await k.batch(
    due.map(({ step }) =>
      k.db
        .update(t.goalSteps)
        .set({ cuePushedFor: step.cueAt, updatedAt: at })
        .where(and(eq(t.goalSteps.id, step.id), eq(t.goalSteps.cueAt, step.cueAt!))),
    ),
  );
}

/**
 * Finds cues whose day has ended with the step still open, marks each once, and adds
 * it to its goal's misses in a row. Returns the goals with a second miss or more.
 */
export async function detectMissedCues(k: Store): Promise<Goal[]> {
  const today = k.today();
  const rows = await k.db
    .select({ goal: t.goals, step: t.goalSteps })
    .from(t.goalSteps)
    .innerJoin(t.goals, eq(t.goals.id, t.goalSteps.goalId))
    .where(
      and(
        eq(t.goalSteps.status, 'open'),
        isNull(t.goalSteps.deletedAt),
        eq(t.goals.status, 'active'),
        isNull(t.goals.deletedAt),
        isNotNull(t.goalSteps.cueAt),
        lt(t.goalSteps.cueAt, `${today}T00:00`),
        or(isNull(t.goalSteps.missedCueAt), ne(t.goalSteps.missedCueAt, t.goalSteps.cueAt)),
      ),
    )
    .orderBy(t.goalSteps.cueAt);
  if (!rows.length) return [];
  const at = k.iso();
  const misses = new Map<string, { goal: Goal; count: number }>();
  for (const { goal } of rows) misses.set(goal.id, { goal, count: (misses.get(goal.id)?.count ?? 0) + 1 });
  await k.batch([
    ...rows.flatMap(({ goal, step }) => [
      k.db
        .update(t.goalSteps)
        .set({ missedCueAt: step.cueAt, updatedAt: at })
        .where(and(eq(t.goalSteps.id, step.id), eq(t.goalSteps.cueAt, step.cueAt!))),
      k.event('goal', goal.id, 'cue missed', { position: step.position, cueAt: step.cueAt }),
    ]),
    ...[...misses.values()].map(({ goal, count }) =>
      k.db
        .update(t.goals)
        .set({ missedInARow: sql`${t.goals.missedInARow} + ${count}`, updatedAt: at })
        .where(eq(t.goals.id, goal.id)),
    ),
  ]);
  return [...misses.values()].filter(({ goal, count }) => goal.missedInARow + count >= 2).map(({ goal, count }) => ({ ...goal, missedInARow: goal.missedInARow + count }));
}

/** A step was missed when its current cue's day ended with it still open. */
export const isMissed = (step: GoalStep) => step.status === 'open' && step.cueAt !== null && step.missedCueAt === step.cueAt;
