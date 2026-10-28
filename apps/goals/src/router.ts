import { useEffect, useState } from 'react';

// Two routes for now: /goals/ (Today) and /goals/new. keel serve answers every
// /goals/... path with the app, so a reload or a shared link lands on the same screen.

export type Route = { name: 'today' } | { name: 'new' };

export function routeOf(pathname: string): Route {
  const rest = pathname.replace(/^\/goals\/?/, '').replace(/\/$/, '');
  return rest === 'new' ? { name: 'new' } : { name: 'today' };
}

const PATHS: Record<Route['name'], string> = { today: '/goals/', new: '/goals/new' };

export function go(name: Route['name'], { replace = false } = {}): void {
  if (replace) window.history.replaceState(null, '', PATHS[name]);
  else window.history.pushState(null, '', PATHS[name]);
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
