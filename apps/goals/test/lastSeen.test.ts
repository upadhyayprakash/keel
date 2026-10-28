import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, unreachable } from '../src/api';
import type { Goal } from '../src/goal';
import { goalByRef, readLastSeen, rememberGoal, saveLastSeen } from '../src/lastSeen';

const goal = (n: number, status: Goal['status'] = 'active') => ({ id: `id-${n}`, ref: `g${n}`, title: `Goal ${n}`, status, steps: [] }) as unknown as Goal;

function memory() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), items };
}

const AT = new Date('2026-10-28T09:00:00Z');

describe('last-seen copy', () => {
  it('keeps what Keel last sent, with when', () => {
    const store = memory();
    saveLastSeen({ today: '2026-10-28', goals: [goal(1), goal(2)] }, AT, store);
    expect(readLastSeen(store)).toEqual({ today: '2026-10-28', goals: [goal(1), goal(2)], savedAt: AT.toISOString() });
  });

  it('reads nothing from an empty, broken or refused store', () => {
    expect(readLastSeen(memory())).toBeNull();
    const broken = memory();
    broken.items.set('keel-goals:last-seen', '{not json');
    expect(readLastSeen(broken)).toBeNull();
    expect(readLastSeen(null)).toBeNull();
    const refusing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(() => saveLastSeen({ today: '2026-10-28', goals: [] }, AT, refusing)).not.toThrow();
  });

  it('updates a goal in place after a step done, and drops one that closed', () => {
    const store = memory();
    saveLastSeen({ today: '2026-10-28', goals: [goal(1), goal(2), goal(3)] }, AT, store);
    rememberGoal({ ...goal(2), title: 'Changed' }, AT, store);
    expect(readLastSeen(store)?.goals.map((g) => g.title)).toEqual(['Goal 1', 'Changed', 'Goal 3']);
    rememberGoal(goal(1, 'done'), AT, store);
    expect(readLastSeen(store)?.goals.map((g) => g.ref)).toEqual(['g2', 'g3']);
  });

  it('finds a goal by ref, any case, or by id', () => {
    const goals = [goal(1), goal(12)];
    expect(goalByRef(goals, 'G12')?.id).toBe('id-12');
    expect(goalByRef(goals, 'id-1')?.ref).toBe('g1');
    expect(goalByRef(goals, 'g7')).toBeNull();
  });
});

describe('not reachable', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is no answer at all, or a tunnel with nothing behind it', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const e = await api('/api/goals').catch((x: unknown) => x);
    expect(unreachable(e)).toBe(true);
    expect((e as ApiError).message).toMatch(/not reachable/);

    vi.stubGlobal('fetch', () => Promise.resolve(new Response('Bad gateway', { status: 502 })));
    const tunnel = await api('/api/goals').catch((x: unknown) => x);
    expect(unreachable(tunnel)).toBe(true);
    expect((tunnel as ApiError).message).toMatch(/not reachable/);
  });

  it('is not an answer Keel gave', () => {
    expect(unreachable(new ApiError('Step 2 was already done.', 409))).toBe(false);
    expect(unreachable(new ApiError('Keel answered 500.', 500))).toBe(false);
    expect(unreachable(new Error('other'))).toBe(false);
  });
});
