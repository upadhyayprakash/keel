import { describe, expect, it } from 'vitest';
import { composePlan, nextStep, type Goal } from '../src/goal';
import { pathOf, routeOf } from '../src/router';

describe('composePlan', () => {
  it('reads as "If ..., then I will ..." whatever the blanks already say', () => {
    expect(composePlan('it is raining at 7:00', 'do 20 minutes on the treadmill')).toBe('If it is raining at 7:00, then I will do 20 minutes on the treadmill.');
    expect(composePlan('If it rains,', 'then I will walk instead.')).toBe('If it rains, then I will walk instead.');
    expect(composePlan('  rainy mornings ', 'I will use the treadmill')).toBe('If rainy mornings, then I will use the treadmill.');
  });

  it('passes the model check for an if-then plan', () => {
    const plan = composePlan('tired', 'read 2 pages');
    expect(/\bif\b/i.test(plan) && /\bthen\b/i.test(plan)).toBe(true);
  });
});

describe('routeOf', () => {
  it('maps paths to screens, Today by default', () => {
    expect(routeOf('/goals/')).toEqual({ name: 'today' });
    expect(routeOf('/goals')).toEqual({ name: 'today' });
    expect(routeOf('/goals/new')).toEqual({ name: 'new' });
    expect(routeOf('/goals/new/')).toEqual({ name: 'new' });
    expect(routeOf('/goals/something-else')).toEqual({ name: 'today' });
  });

  it('opens a goal by its ref, and back to the same path', () => {
    expect(routeOf('/goals/g3')).toEqual({ name: 'goal', ref: 'g3' });
    expect(routeOf('/goals/G12/')).toEqual({ name: 'goal', ref: 'g12' });
    expect(routeOf('/goals/g3/steps')).toEqual({ name: 'today' });
    expect(pathOf({ name: 'goal', ref: 'g3' })).toBe('/goals/g3');
    expect(pathOf({ name: 'today' })).toBe('/goals/');
  });
});

describe('nextStep', () => {
  const steps = (...status: Array<'open' | 'done'>) =>
    ({ steps: status.map((s, i) => ({ position: i + 1, text: `step ${i + 1}`, status: s })) }) as unknown as Goal;

  it('is the first open step, even after a later one was done', () => {
    expect(nextStep(steps('done', 'open', 'open'))?.position).toBe(2);
    expect(nextStep(steps('open', 'done', 'open'))?.position).toBe(1);
  });

  it('is null when every step is done', () => {
    expect(nextStep(steps('done', 'done'))).toBeNull();
  });
});
