import { useEffect, useState } from 'react';

// /goals/ (Today), /goals/new and /goals/<ref> (a goal, `g3`). keel serve answers every
// /goals/... path with the app, so a reload or a shared link lands on the same screen.

export type Route = { name: 'today' } | { name: 'new' } | { name: 'goal'; ref: string };

export function routeOf(pathname: string): Route {
  const rest = pathname.replace(/^\/goals\/?/, '').replace(/\/$/, '');
  if (rest === 'new') return { name: 'new' };
  if (/^g\d+$/i.test(rest)) return { name: 'goal', ref: rest.toLowerCase() };
  return { name: 'today' };
}

export function pathOf(route: Route): string {
  if (route.name === 'goal') return `/goals/${route.ref}`;
  return route.name === 'new' ? '/goals/new' : '/goals/';
}

export function go(to: Route | 'today' | 'new', { replace = false } = {}): void {
  const path = pathOf(typeof to === 'string' ? { name: to } : to);
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
