// The goal as the API sends it: the same fields as `keel goal show --json` (ADR 0004).

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
