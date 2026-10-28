// The Goals app's only way to reach Keel: /api/goals/... and /api/auth/state (ADR 0004).
// With login on and no Goals session, it goes to the shared sign-in page, which
// comes back here afterwards (ADR 0002).

export interface AuthState {
  login: boolean;
  signedIn: { goals: boolean; terminal: boolean };
}

/** Whether this page can open, from GET /api/auth/state. A terminal session counts as a Goals one on the server. */
export const needsSignIn = (state: AuthState) => state.login && !state.signedIn.goals;

/** The sign-in page, coming back to `here` (path, query and hash of this page). */
export function signInUrl(here: Pick<Location, 'pathname' | 'search' | 'hash'>): string {
  const next = `${here.pathname}${here.search}${here.hash}`;
  return `/signin?scope=goals&next=${encodeURIComponent(next.startsWith('/goals') ? next : '/goals/')}`;
}

/** Leaves for the sign-in page. `replace`, so Back doesn't return to a page that can't load. */
export function goSignIn(): void {
  window.location.replace(signInUrl(window.location));
}

/** An answer the server gave in words: `{ error, hint, field }`. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint: string | null = null,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Calls the API. A 401 means the session ended: go and sign in again. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    goSignIn();
    throw new ApiError('Sign in first.', 401);
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string; hint?: string | null; field?: string | null }) | null;
  if (!res.ok) throw new ApiError(data?.error ?? `Keel answered ${res.status}.`, res.status, data?.hint ?? null, data?.field ?? null);
  return data as T;
}

export const authState = () => api<AuthState>('/api/auth/state');
