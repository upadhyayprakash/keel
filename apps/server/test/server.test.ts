import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keel } from '@keel/core';
import { createApp } from '../src/index';

const HOST = { host: '127.0.0.1:4242' };
let keel: Keel;
let app: ReturnType<typeof createApp>;
let dist: string;

beforeEach(async () => {
  keel = await Keel.open({ url: ':memory:' });
  dist = mkdtempSync(join(tmpdir(), 'keel-web-'));
  writeFileSync(join(dist, 'index.html'), '<title>keel</title>');
  app = createApp({ keel, port: 4242, webDist: dist });
});

afterEach(() => keel.close());

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request('/api/run', {
    method: 'POST',
    headers: { ...HOST, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('api', () => {
  it('runs a command and returns blocks plus state', async () => {
    await post({ line: 'client new acme Acme' });
    await post({ line: 'project new acme/website Website' });
    const res = await post({ line: 'owe deck @ravi due:tomorrow' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { blocks: Array<{ kind: string }>; state: { context: { path: string } } };
    expect(json.blocks[0]?.kind).toBe('status');
    expect(json.state.context.path).toBe('acme/website');
  });

  it('asks and answers questions across requests', async () => {
    await post({ line: 'client new acme Acme' });
    await post({ line: 'project new acme/website Website' });
    const started = (await (await post({ line: 'park' })).json()) as { question?: { prompt: string }; session?: string };
    expect(started.question?.prompt).toBe('Where are you?');
    const answer = (text: string | null) =>
      app.request('/api/answer', {
        method: 'POST',
        headers: { ...HOST, 'content-type': 'application/json' },
        body: JSON.stringify({ session: started.session, text }),
      });
    await answer('pricing copy done');
    await answer('');
    const done = (await (await answer('')).json()) as { blocks: Array<{ kind: string }>; question?: unknown; state: { context: unknown } };
    expect(done.question).toBeUndefined();
    expect(done.state.context).toBeNull();
  });

  it('completes', async () => {
    const res = await app.request('/api/complete?line=to', { headers: HOST });
    expect(((await res.json()) as { suggestions: Array<{ insert: string }> }).suggestions[0]?.insert).toBe('today');
  });

  it('refuses other hosts, other origins and non-JSON posts', async () => {
    expect((await app.request('/api/state', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await post({ line: 'today' }, { origin: 'https://evil.example' })).status).toBe(403);
    const plain = await app.request('/api/run', { method: 'POST', headers: { ...HOST, 'content-type': 'text/plain' }, body: '{"line":"today"}' });
    expect(plain.status).toBe(415);
  });

  it('serves the browser terminal and never files outside it', async () => {
    expect(await (await app.request('/', { headers: HOST })).text()).toContain('<title>keel</title>');
    const escape = await app.request('/..%2f..%2fetc%2fpasswd', { headers: HOST });
    expect(await escape.text()).toContain('<title>keel</title>');
  });
});
