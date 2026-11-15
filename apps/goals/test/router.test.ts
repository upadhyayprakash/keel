import { describe, expect, it } from 'vitest';
import { pathOf, routeOf } from '../src/router';

describe('routes', () => {
  it('reads goals and lists from the path', () => {
    expect(routeOf('/goals/')).toEqual({ name: 'today' });
    expect(routeOf('/goals/new')).toEqual({ name: 'new' });
    expect(routeOf('/goals/G3')).toEqual({ name: 'goal', ref: 'g3' });
    expect(routeOf('/goals/g3/review')).toEqual({ name: 'review', ref: 'g3' });
    expect(routeOf('/goals/lists')).toEqual({ name: 'lists' });
    expect(routeOf('/goals/lists/')).toEqual({ name: 'lists' });
    expect(routeOf('/goals/lists/new')).toEqual({ name: 'list-new' });
    expect(routeOf('/goals/lists/L12')).toEqual({ name: 'list', ref: 'l12' });
    expect(routeOf('/goals/lists/g3')).toEqual({ name: 'today' });
    expect(routeOf('/goals/lists/l3/extra')).toEqual({ name: 'today' });
  });

  it('writes the path back, so a reload or a shared link lands on the same screen', () => {
    for (const path of ['/goals/', '/goals/new', '/goals/g3', '/goals/g3/review', '/goals/lists', '/goals/lists/new', '/goals/lists/l3']) {
      expect(pathOf(routeOf(path))).toBe(path);
    }
  });
});
