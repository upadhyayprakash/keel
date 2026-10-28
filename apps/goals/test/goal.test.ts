import { describe, expect, it } from 'vitest';
import { composePlan } from '../src/goal';
import { routeOf } from '../src/router';

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
});
