// The goal as the API sends it: the same fields as `keel goal show --json` (ADR 0004).

import { dayDiff, localDay } from './format';

export interface GoalStep {
  position: number;
  text: string;
  cueAt: string | null;
  cuePlace: string | null;
  minimum: string | null;
  firstStep: boolean;
  status: 'open' | 'done';
  doneAt: string | null;
}

export interface Goal {
  ref: string;
  id: string;
  title: string;
  doneMeans: string;
  dueOn: string;
  appetite: string | null;
  obstacle: string | null;
  plan: string;
  status: 'active' | 'done' | 'dropped';
  progress: { done: number; total: number; label: string };
  steps: GoalStep[];
  createdAt: string;
  closedAt: string | null;
}

/** What POST /api/goals takes. */
export interface NewGoal {
  title: string;
  doneMeans: string;
  dueOn: string;
  appetite: string | null;
  obstacle: string | null;
  plan: string;
  steps: Array<{ text: string; cueAt: string | null; cuePlace: string | null; minimum: string | null }>;
}

/** "If <when>, then I will <what>." from the two blanks on the plan card. */
export function composePlan(when: string, what: string): string {
  const w = when.trim().replace(/^if\s+/i, '').replace(/[,.]\s*$/, '');
  const t = what.trim().replace(/^(then\s+)?(i\s+will\s+)?/i, '').replace(/\.\s*$/, '');
  return `If ${w}, then I will ${t}.`;
}

/** The step Today offers: the first open one. Null when every step is done. */
export const nextStep = (goal: Goal): GoalStep | null => goal.steps.find((s) => s.status === 'open') ?? null;

/** What POST /api/goals/<ref>/close takes. The answers may be empty. */
export interface CloseReview {
  outcome: 'done' | 'dropped';
  happened: string;
  why: string;
  change: string;
}

/** GET /api/goals/padding: how late past goals ran, and the given deadline stretched by as much. */
export interface PaddingAnswer {
  today: string;
  padding: { goals: number; percent: number; note: string } | null;
  paddedOn: string | null;
}

/**
 * "Planned 27 days, took 31: 4 days over.", the same line as `keel goal done`.
 * Counted from the day the goal was made (in this phone's time) to `today`.
 */
export function planVsTookText(goal: Pick<Goal, 'createdAt' | 'dueOn'>, today: string): string {
  const start = localDay(goal.createdAt);
  const planned = Math.max(0, dayDiff(start, goal.dueOn));
  const took = Math.max(0, dayDiff(start, today));
  const diff = took - planned;
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  return `Planned ${days(planned)}, took ${took}${diff > 0 ? `: ${days(diff)} over` : diff < 0 ? `: ${days(-diff)} early` : ', on time'}.`;
}
