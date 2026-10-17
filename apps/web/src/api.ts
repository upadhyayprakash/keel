import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/browser';
import type { Completion, KeelState, RunResult } from '@keel/core/ui';

export type ApiResult = RunResult & { state: KeelState };

/** Sent on `window` when the server says the session is gone, so the sign-in screen comes back. */
export const SIGNED_OUT = 'keel:signed-out';

async function json<T>(res: Response): Promise<T> {
  if (res.status === 401) window.dispatchEvent(new Event(SIGNED_OUT));
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body: unknown) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => json<T>(r));

export const api = {
  run: (line: string) => post<ApiResult>('/api/run', { line }),
  /** `null` cancels the waiting command. */
  answer: (session: string, text: string | null) => post<ApiResult>('/api/answer', { session, text }),
  state: () => fetch('/api/state').then((r) => json<KeelState>(r)),
  complete: (line: string) => fetch(`/api/complete?line=${encodeURIComponent(line)}`).then((r) => json<Completion>(r)),
};

export type Scope = 'goals' | 'terminal';
export interface AuthState {
  login: boolean;
  passkeys?: boolean;
  /** Six-digit codes are turned on (`keel auth totp enable`). */
  totp?: boolean;
  /** The public address passkeys belong to. */
  origin?: string;
  signedIn: { goals: boolean; terminal: boolean };
}

/** An answer from the login API that the user can act on: its message and hint. */
class Problem extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

/** Login calls answer with { error, hint } on failure; never fire SIGNED_OUT for them. */
async function authPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; hint?: string };
  if (!res.ok) throw new Problem(data.error ?? `Keel answered ${res.status}.`, data.hint);
  return data;
}

export const authApi = {
  Problem,
  state: async (): Promise<AuthState> => {
    const res = await fetch('/api/auth/state');
    if (!res.ok) throw new Error(String(res.status));
    return res.json() as Promise<AuthState>;
  },
  pairOptions: (token: string) => authPost<{ options: PublicKeyCredentialCreationOptionsJSON; name: string }>('/api/auth/pair/options', { token }),
  pair: (token: string, response: RegistrationResponseJSON) => authPost<{ paired: string }>('/api/auth/pair/verify', { token, response }),
  signInOptions: () => authPost<{ options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/signin/options', {}),
  signIn: (scope: Scope, response: AuthenticationResponseJSON) => authPost<{ signedIn: Scope; ends: string }>('/api/auth/signin/verify', { scope, response }),
  signInCode: (scope: Scope, code: string) => authPost<{ signedIn: Scope; ends: string }>('/api/auth/totp/verify', { scope, code }),
  signOut: () => authPost<{ signedOut: true }>('/api/auth/signout', {}),
};
