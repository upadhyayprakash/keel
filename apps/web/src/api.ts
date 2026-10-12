import type { Block, Completion, KeelState } from '@keel/core/ui';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  run: (line: string) =>
    fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ line }),
    }).then((r) => json<{ blocks: Block[]; state: KeelState }>(r)),
  state: () => fetch('/api/state').then((r) => json<KeelState>(r)),
  complete: (line: string) => fetch(`/api/complete?line=${encodeURIComponent(line)}`).then((r) => json<Completion>(r)),
};
