import { useEffect, useState } from 'react';

// /goals/ (Today), /goals/new, /goals/<ref> (a goal, `g3`) and /goals/<ref>/review (close it), plus Lists (ADR 0005):
// /goals/lists, /goals/lists/new and /goals/lists/<ref> (a list, `l3`). keel serve answers every /goals/... path
// with the app, so a reload or a shared link lands on the same screen.

export type Route =
  | { name: 'today' }
  | { name: 'new' }
  | { name: 'goal'; ref: string }
  | { name: 'review'; ref: string }
  | { name: 'lists' }
  | { name: 'list-new' }
  | { name: 'list'; ref: string };

export function routeOf(pathname: string): Route {
  const rest = pathname.replace(/^\/goals\/?/, '').replace(/\/$/, '');
  if (rest === 'new') return { name: 'new' };
  if (/^g\d+$/i.test(rest)) return { name: 'goal', ref: rest.toLowerCase() };
  const review = /^(g\d+)\/review$/i.exec(rest);
  if (review) return { name: 'review', ref: review[1]!.toLowerCase() };
  if (rest === 'lists') return { name: 'lists' };
  if (rest === 'lists/new') return { name: 'list-new' };
  const list = /^lists\/(l\d+)$/i.exec(rest);
  if (list) return { name: 'list', ref: list[1]!.toLowerCase() };
  return { name: 'today' };
}

export function pathOf(route: Route): string {
  switch (route.name) {
    case 'goal':
      return `/goals/${route.ref}`;
    case 'review':
      return `/goals/${route.ref}/review`;
    case 'new':
      return '/goals/new';
    case 'lists':
      return '/goals/lists';
    case 'list-new':
      return '/goals/lists/new';
    case 'list':
      return `/goals/lists/${route.ref}`;
    default:
      return '/goals/';
  }
}

export function go(to: Route | Exclude<Route['name'], 'goal' | 'review' | 'list'>, { replace = false } = {}): void {
  const path = pathOf(typeof to === 'string' ? ({ name: to } as Route) : to);
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => routeOf(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(routeOf(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return route;
}
