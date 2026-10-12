import type { Completion, KeelState, RunResult } from '@keel/core/ui';

export type ApiResult = RunResult & { state: KeelState };

async function json<T>(res: Response): Promise<T> {
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
