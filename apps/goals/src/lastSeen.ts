import { api, unreachable, type ApiError } from './api';
import type { Goal } from './goal';

// The goals this phone last saw from Keel, so Today and a goal's page still open
// while keel serve is not reachable (the computer sleeps). They show as not live,
// and nothing is written until Keel answers again: ADR 0003 allows no offline writes (ADR 0004).

export interface GoalList {
  today: string;
  goals: Goal[];
}

export interface LastSeen extends GoalList {
  /** When Keel last answered, as an ISO time. */
  savedAt: string;
}

/** Live from Keel, or the last-seen copy (null when this phone has none) with the reason. */
export type Loaded = { live: true; list: GoalList } | { live: false; list: LastSeen | null; error: ApiError };

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const KEY = 'keel-goals:last-seen';

/** localStorage, or null where the browser refuses it (private mode, blocked site data). */
function local(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readLastSeen(store: Store | null = local()): LastSeen | null {
  try {
    const data = JSON.parse(store?.getItem(KEY) ?? 'null') as Partial<LastSeen> | null;
    if (!data || typeof data.today !== 'string' || typeof data.savedAt !== 'string' || !Array.isArray(data.goals)) return null;
    return data as LastSeen;
  } catch {
    return null;
  }
}

export function saveLastSeen(list: GoalList, now = new Date(), store: Store | null = local()): void {
  try {
    store?.setItem(KEY, JSON.stringify({ today: list.today, goals: list.goals, savedAt: now.toISOString() } satisfies LastSeen));
  } catch {
    // Full or refused: the app still works live, it just has nothing to show offline.
  }
}

/** Puts a goal Keel just sent (after a step done) into the copy. A goal that is no longer active leaves it. */
export function rememberGoal(goal: Goal, now = new Date(), store: Store | null = local()): void {
  const seen = readLastSeen(store);
  if (!seen) return;
  const goals = seen.goals.filter((g) => g.id !== goal.id);
  if (goal.status === 'active') goals.splice(Math.max(0, seen.goals.findIndex((g) => g.id === goal.id)), 0, goal);
  saveLastSeen({ today: seen.today, goals }, now, store);
}

/** The active goals: from Keel when it answers (and kept for later), else the last-seen copy. Other errors throw. */
export async function loadGoals(): Promise<Loaded> {
  try {
    const list = await api<GoalList>('/api/goals');
    saveLastSeen(list);
    return { live: true, list };
  } catch (e) {
    if (unreachable(e)) return { live: false, list: readLastSeen(), error: e };
    throw e;
  }
}

/** Marks a step done at Keel and keeps the copy current. Never queued: when Keel is not reachable this throws and nothing changes. */
export async function markStepDone(goal: Goal, position: number): Promise<Goal> {
  const updated = await api<Goal>(`/api/goals/${encodeURIComponent(goal.ref)}/steps/${position}/done`, { method: 'POST' });
  rememberGoal(updated);
  return updated;
}

/** Why a tap did nothing, in words. */
export const notMarked = (e: unknown) => (unreachable(e) ? 'Keel is not reachable, so this step is not marked done. Try again once keel serve is running.' : (e as Error).message);

/** A goal by its ref (`g3`) or id, as the URL names it. */
export const goalByRef = (goals: Goal[], ref: string) => goals.find((g) => g.ref.toLowerCase() === ref.toLowerCase() || g.id === ref) ?? null;
