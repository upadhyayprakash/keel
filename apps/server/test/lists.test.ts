import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keel } from '@keel/core';
import { createApp } from '../src/index';

// Monday 12 October 2026, 09:00 local time.
const HOST = { host: '127.0.0.1:4242' };
let keel: Keel;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  keel = await Keel.open({ url: ':memory:', now: () => new Date(2026, 9, 12, 9, 0) });
  app = createApp({ keel, port: 4242 });
});
afterEach(() => keel.close());

const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { ...HOST, ...headers } });
const send = (method: string, path: string, body?: unknown, type = 'application/json') =>
  app.request(path, { method, headers: { ...HOST, 'content-type': type }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const post = (path: string, body?: unknown) => send('POST', path, body);
const patch = (path: string, body?: unknown) => send('PATCH', path, body);

type Item = { number: number; id: string; text: string; state: string; note: string | null; doneAt: string | null };
type ListJson = {
  ref: string;
  id: string;
  name: string;
  kind: string;
  project: string;
  viewSort: string;
  pinned: boolean;
  status: string;
  progress: { done: number; total: number; label: string } | null;
  cover: { kind: string; dark: boolean } | null;
  items: Item[];
  shownOrder: number[];
};
type ErrorJson = { error: string; hint: string | null; field: string | null };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

async function made(body: Record<string, unknown> = {}): Promise<ListJson> {
  const res = await post('/api/lists', { name: 'D-mart', kind: 'tracked', items: ['milk', 'eggs', 'bread'], ...body });
  expect(res.status).toBe(201);
  return (await res.json()) as ListJson;
}

describe('creating and reading lists', () => {
  it('creates a list in Personal and returns it like list show --json', async () => {
    const list = await made({ tags: ['#groceries'], description: 'Weekly shop' });
    expect(list).toMatchObject({ ref: 'l1', name: 'D-mart', kind: 'tracked', project: 'personal/general', status: 'active', pinned: false, progress: { done: 0, total: 3, label: '0 of 3 done' }, cover: null });
    expect(list.items.map((i) => [i.number, i.text, i.state])).toEqual([[1, 'milk', 'open'], [2, 'eggs', 'open'], [3, 'bread', 'open']]);

    const cli = (await keel.exec('list show l1 --json')).blocks[0] as { text: string };
    expect(await (await get('/api/lists/l1')).json()).toEqual((JSON.parse(cli.text) as { data: unknown }).data);
  });

  it('puts a list in a named project or a client, and offers those places', async () => {
    await keel.run('client new acme "Acme Corp"');
    await keel.run('project new acme/website "Website rebuild"');
    expect((await made({ project: 'acme/website' })).project).toBe('acme/website');
    expect((await made({ project: 'acme' })).project).toBe('acme/general');
    expect((await made({ project: 'personal' })).project).toBe('personal/general');
    expect(((await (await post('/api/lists', { name: 'x', project: 'nope' })).json()) as ErrorJson).error).toContain('No client nope');
    const targets = (await (await get('/api/lists/targets')).json()) as { targets: Array<{ value: string; label: string }> };
    expect(targets.targets).toEqual([
      { value: 'personal', label: 'Personal' },
      { value: 'acme', label: 'Acme Corp (general)' },
      { value: 'acme/website', label: 'Acme Corp / Website rebuild' },
    ]);
  });

  it('lists summaries without items, and filters', async () => {
    await made({ name: 'Groceries', tags: ['home'] });
    await made({ name: 'Trip', kind: 'plain', pinned: true, items: ['passport'] });
    const res = await get('/api/lists');
    const { lists } = (await res.json()) as { lists: Array<Record<string, unknown>> };
    expect(lists.map((l) => l.name)).toEqual(['Trip', 'Groceries']);
    expect(lists[0]).toMatchObject({ itemCount: 1, progress: null, pinned: true, cover: null });
    expect(lists[0]).not.toHaveProperty('items');
    expect(lists[1]).toMatchObject({ itemCount: 3, progress: { total: 3 }, tags: ['home'] });
    const names = async (q: string) => ((await (await get(`/api/lists${q}`)).json()) as { lists: Array<{ name: string }> }).lists.map((l) => l.name);
    expect(await names('?tag=home')).toEqual(['Groceries']);
    expect(await names('?q=tri')).toEqual(['Trip']);
    expect(await names('?project=personal')).toEqual(['Trip', 'Groceries']);
    expect(await names('?status=archived')).toEqual([]);
    expect((await get('/api/lists?status=odd')).status).toBe(400);
  });

  it('says which field is wrong, so the form can show it there', async () => {
    const name = await post('/api/lists', { name: ' ' });
    expect(name.status).toBe(400);
    expect(await name.json()).toEqual({ error: 'A list needs a name.', hint: expect.stringContaining('D-mart'), field: 'name' });
    expect(((await (await post('/api/lists', { name: 'x', kind: 'odd' })).json()) as ErrorJson).field).toBe('kind');
    expect(((await (await post('/api/lists', { name: 'x', items: [1] })).json()) as ErrorJson).field).toBe('items');
    expect(((await (await post('/api/lists', { name: 'x', tags: ['a', 'b', 'c', 'd', 'e', 'f'] })).json()) as ErrorJson).field).toBe('tags');
    expect(((await (await post('/api/lists', { name: 42 })).json()) as ErrorJson).field).toBe('name');
    expect((await get('/api/lists/l9')).status).toBe(404);
  });

  it('refuses bodies that are not a JSON object', async () => {
    expect((await send('POST', '/api/lists', { name: 'x' }, 'text/plain')).status).toBe(415);
    expect((await post('/api/lists', [1])).status).toBe(400);
    expect((await send('POST', '/api/lists', '{')).status).toBe(400);
  });
});

describe('changing a list', () => {
  it('patches fields, and pin, archive and sort', async () => {
    await made();
    const res = await patch('/api/lists/l1', { name: 'D-Mart run', description: null, tags: ['weekly'], pinned: true, viewSort: 'state' });
    expect(await res.json()).toMatchObject({ name: 'D-Mart run', description: null, tags: ['weekly'], pinned: true, viewSort: 'state' });
    expect(((await (await patch('/api/lists/l1', { status: 'archived' })).json()) as ListJson).status).toBe('archived');
    expect(((await (await get('/api/lists')).json()) as { lists: unknown[] }).lists).toEqual([]);
    expect(((await (await get('/api/lists?status=archived')).json()) as { lists: unknown[] }).lists).toHaveLength(1);
    expect(((await (await patch('/api/lists/l1', { viewSort: 'random' })).json()) as ErrorJson).field).toBe('viewSort');
    expect(((await (await patch('/api/lists/l1', { pinned: 'yes' })).json()) as ErrorJson).field).toBe('pinned');
    expect(((await (await patch('/api/lists/l1', { status: 'gone' })).json()) as ErrorJson).field).toBe('status');
    expect(((await (await patch('/api/lists/l1', { name: 5 })).json()) as ErrorJson).field).toBe('name');
  });

  it('moves a list to another project, and deletes it', async () => {
    await keel.run('client new acme "Acme Corp"');
    await keel.run('project new acme/website "Website"');
    await made();
    expect(((await (await post('/api/lists/l1/move', { project: 'acme/website' })).json()) as ListJson).project).toBe('acme/website');
    expect(((await (await post('/api/lists/l1/move', { project: 'acme/website' })).json()) as ErrorJson).error).toContain('already in');
    expect(await (await send('DELETE', '/api/lists/l1')).json()).toEqual({ deleted: true, ref: 'l1', items: 3 });
    expect((await get('/api/lists/l1')).status).toBe(404);
    expect((await send('DELETE', '/api/lists/l1')).status).toBe(404);
  });
});

describe('items', () => {
  it('adds, changes, ticks and removes items', async () => {
    const list = await made();
    const [milk, eggs] = list.items;
    const added = (await (await post('/api/lists/l1/items', { texts: ['rice', 'oil'] })).json()) as ListJson;
    expect(added.items.map((i) => i.text)).toEqual(['milk', 'eggs', 'bread', 'rice', 'oil']);
    expect(((await (await post('/api/lists/l1/items', { text: 'tea' })).json()) as ListJson).items).toHaveLength(6);
    expect(((await (await post('/api/lists/l1/items', { texts: [' '] })).json()) as ErrorJson).error).toContain('some text');
    expect(((await (await post('/api/lists/l1/items', {})).json()) as ErrorJson).field).toBe('texts');

    const edited = (await (await patch(`/api/lists/l1/items/${milk!.id}`, { text: 'oat milk', note: 'blue one' })).json()) as ListJson;
    expect(edited.items[0]).toMatchObject({ text: 'oat milk', note: 'blue one' });
    const ticked = (await (await patch(`/api/lists/l1/items/${milk!.id}`, { state: 'done' })).json()) as ListJson;
    expect(ticked.items[0]!.state).toBe('done');
    expect(ticked.progress).toEqual({ done: 1, total: 6, label: '1 of 6 done' });
    expect(((await (await patch(`/api/lists/l1/items/${eggs!.id}`, { state: 'later' })).json()) as ErrorJson).error).toContain('open, doing, blocked, done');

    const removed = (await (await send('DELETE', `/api/lists/l1/items/${eggs!.id}`)).json()) as ListJson;
    expect(removed.items.map((i) => i.text)).not.toContain('eggs');
    expect((await send('DELETE', `/api/lists/l1/items/${eggs!.id}`)).status).toBe(404);
  });

  it('answers a second tick with a 409 that says when', async () => {
    const [milk] = (await made()).items;
    expect((await patch(`/api/lists/l1/items/${milk!.id}`, { state: 'done' })).status).toBe(200);
    const again = await patch(`/api/lists/l1/items/${milk!.id}`, { state: 'done' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrorJson).error).toMatch(/"milk" in l1 was already done/);
    // Other changes still go through.
    expect((await patch(`/api/lists/l1/items/${milk!.id}`, { state: 'open' })).status).toBe(200);
  });

  it('drags an item, and the list goes back to manual', async () => {
    const [milk, eggs, bread] = (await made()).items;
    await patch('/api/lists/l1', { viewSort: 'alpha' });
    const moved = (await (await post(`/api/lists/l1/items/${bread!.id}/move`, { afterId: null })).json()) as ListJson;
    expect(moved.items.map((i) => i.text)).toEqual(['bread', 'milk', 'eggs']);
    expect(moved.viewSort).toBe('manual');
    const after = (await (await post(`/api/lists/l1/items/${bread!.id}/move`, { afterId: milk!.id })).json()) as ListJson;
    expect(after.items.map((i) => i.text)).toEqual(['milk', 'bread', 'eggs']);
    expect(((await (await post(`/api/lists/l1/items/${bread!.id}/move`, { afterId: 5 })).json()) as ErrorJson).field).toBe('afterId');
    expect((await post(`/api/lists/l1/items/${bread!.id}/move`, { afterId: 'nope' })).status).toBe(404);
    expect(eggs).toBeDefined();
  });

  it('shows the list sorted by state without changing its stored order', async () => {
    const [milk, eggs] = (await made()).items;
    await patch(`/api/lists/l1/items/${milk!.id}`, { state: 'done' });
    await patch(`/api/lists/l1/items/${eggs!.id}`, { state: 'doing' });
    const sorted = (await (await patch('/api/lists/l1', { viewSort: 'state' })).json()) as ListJson;
    expect(sorted.items.map((i) => i.text)).toEqual(['milk', 'eggs', 'bread']);
    expect(sorted.shownOrder).toEqual([2, 3, 1]);
  });

  it('resets a tracked list, and says nothing was reset when everything is open', async () => {
    const list = await made();
    await patch(`/api/lists/l1/items/${list.items[0]!.id}`, { state: 'done' });
    const reset = (await (await post('/api/lists/l1/reset')).json()) as ListJson & { reset: number; resetCount: number };
    expect(reset).toMatchObject({ reset: 1, resetCount: 1 });
    expect(reset.items.every((i) => i.state === 'open')).toBe(true);
    expect(((await (await post('/api/lists/l1/reset')).json()) as { reset: number }).reset).toBe(0);
    await made({ name: 'Ideas', kind: 'plain' });
    expect(((await (await post('/api/lists/l2/reset')).json()) as ErrorJson).error).toContain('plain list');
  });
});

describe('covers', () => {
  it('sets a cover, serves it as an image with locked-down headers, and clears it', async () => {
    await made();
    expect((await get('/api/lists/l1/cover')).status).toBe(404);
    const dark = SVG.replace('<rect', '<rect fill="#111"');
    const set = await send('PUT', '/api/lists/l1/cover', { kind: 'svg', data: SVG.replace('<rect', '<script>alert(1)</script><rect onclick="x()"'), dark });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ cover: { kind: 'svg', dark: true }, overNotice: false });

    const light = await get('/api/lists/l1/cover');
    expect(light.status).toBe(200);
    expect(light.headers.get('content-type')).toBe('image/svg+xml');
    expect(light.headers.get('x-content-type-options')).toBe('nosniff');
    expect(light.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await light.text()).toBe(SVG); // cleaned on the way in
    expect(await (await get('/api/lists/l1/cover?theme=dark')).text()).toContain('fill="#111"');

    const etag = light.headers.get('etag')!;
    expect((await get('/api/lists/l1/cover', { 'if-none-match': etag })).status).toBe(304);

    const cleared = (await (await send('DELETE', '/api/lists/l1/cover')).json()) as ListJson;
    expect(cleared.cover).toBeNull();
    expect((await get('/api/lists/l1/cover')).status).toBe(404);
  });

  it('serves a PNG as a PNG, and falls back to the one cover in dark mode', async () => {
    await made();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    expect((await send('PUT', '/api/lists/l1/cover', { kind: 'png', data: png.toString('base64') })).status).toBe(200);
    const res = await get('/api/lists/l1/cover?theme=dark');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
  });

  it('refuses what is not a usable cover, saying which field', async () => {
    await made();
    expect(((await (await send('PUT', '/api/lists/l1/cover', { kind: 'gif', data: 'x' })).json()) as ErrorJson).field).toBe('kind');
    expect(((await (await send('PUT', '/api/lists/l1/cover', { kind: 'svg', data: 5 })).json()) as ErrorJson).field).toBe('data');
    expect(((await (await send('PUT', '/api/lists/l1/cover', { kind: 'svg', data: '<div/>' })).json()) as ErrorJson).error).toContain("isn't an SVG");
    expect(((await (await send('PUT', '/api/lists/l1/cover', { kind: 'png', data: Buffer.from('not a png').toString('base64') })).json()) as ErrorJson).error).toContain("isn't a PNG");
    const huge = SVG.replace('<rect', `<path d="${'M0 0 '.repeat(50_000)}"/><rect`);
    expect(((await (await send('PUT', '/api/lists/l1/cover', { kind: 'svg', data: huge })).json()) as ErrorJson).error).toContain('200 KB');
    expect(((await (await send('PUT', '/api/lists/l1/cover', { kind: 'svg', data: SVG, dark: 5 })).json()) as ErrorJson).field).toBe('dark');
    expect((await get('/api/lists/l1')).status).toBe(200);
  });
});
