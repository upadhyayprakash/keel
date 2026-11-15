import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDb, openDb, upToDate } from '../src/db/client';
import { COVER_STORAGE_NOTICE_BYTES } from '../src/covers';
import * as t from '../src/db/schema';
import { Conflict, KeelError } from '../src/errors';
import type { Keel } from '../src/keel';
import {
  addItems,
  changeItems,
  coverBytes,
  createList,
  deleteList,
  findList,
  isComplete,
  itemAt,
  listLists,
  moveItem,
  moveList,
  progressOf,
  removeItems,
  resetList,
  setCover,
  shownItems,
  updateList,
} from '../src/lists';
import type { Store } from '../src/store';
import { openTestKeel } from './helpers';

// Monday 12 October 2026, 09:00 local time.
const now = () => new Date(2026, 9, 12, 9, 0);
let keel: Keel;
let k: Store;

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const personal = { personal: true } as const;
const texts = (v: { items: Array<{ text: string }> }) => v.items.map((i) => i.text);

/** Lets "another device" act after this device has read, but before its write lands. */
function meanwhile(store: Store, other: () => Promise<unknown>): void {
  const original = store.batch.bind(store);
  store.batch = async (queries) => {
    store.batch = original;
    await other();
    return original(queries);
  };
}

async function acme() {
  await keel.run('client new acme "Acme Corp"');
  await keel.run('project new acme/website "Website rebuild"');
  return { project: await k.projectByPath('acme/website'), client: (await k.clientBySlug('acme'))! };
}

beforeEach(async () => {
  keel = await openTestKeel(now);
  k = keel.store;
});
afterEach(() => keel.close());

describe('the migration', () => {
  it('adds the list tables to a 0.5 database, keeps its projects and makes none a default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-lists-migrate-'));
    try {
      // The migrations as they were before lists: everything up to 0004.
      const old = join(dir, 'drizzle');
      cpSync(fileURLToPath(new URL('../drizzle', import.meta.url)), old, { recursive: true });
      rmSync(join(old, '0005_lists.sql'));
      const journal = JSON.parse(readFileSync(join(old, 'meta', '_journal.json'), 'utf8'));
      journal.entries = journal.entries.filter((e: { tag: string }) => !e.tag.includes('lists'));
      writeFileSync(join(old, 'meta', '_journal.json'), JSON.stringify(journal));

      const { db, client } = openDb({ url: `file:${join(dir, 'keel.db')}` });
      await migrate(db, { migrationsFolder: old });
      await db.run(sql`insert into clients (id, created_at, updated_at, slug, name, color) values ('c1', 'x', 'x', 'acme', 'Acme', 'teal')`);
      await db.run(sql`insert into projects (id, created_at, updated_at, ref_no, client_id, slug, name) values ('p1', 'x', 'x', 1, 'c1', 'website', 'Website')`);
      expect(await upToDate(db)).toBe(false);

      await migrateDb(db);
      expect(await upToDate(db)).toBe(true);
      const tables = await client.execute("select name from sqlite_master where type = 'table'");
      expect(tables.rows.map((r) => r.name)).toEqual(expect.arrayContaining(['lists', 'list_items']));
      expect((await db.select().from(t.projects)).map((p) => [p.slug, p.isDefault])).toEqual([['website', false]]);
      client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('where a list lands', () => {
  it('puts a list with no project in Personal / General, made the first time', async () => {
    const view = await createList(k, { name: 'D-mart', target: personal, kind: 'tracked' });
    expect(view.project.path).toBe('personal/general');
    expect(view.project.project.isDefault).toBe(true);
    expect(view.project.client.name).toBe('Personal');
    expect(view.list.refNo).toBe(1);

    // The second list reuses both; nothing is made twice.
    const again = await createList(k, { name: 'Packing', target: personal });
    expect(again.project.project.id).toBe(view.project.project.id);
    expect((await k.listClients(true)).filter((c) => c.slug === 'personal')).toHaveLength(1);
    expect((await k.listProjects(true)).filter((p) => p.project.isDefault)).toHaveLength(1);
  });

  it("puts a list for a client in that client's General project", async () => {
    const { client } = await acme();
    const view = await createList(k, { name: 'Ideas', target: { client } });
    expect(view.project.path).toBe('acme/general');
    expect(view.project.project.isDefault).toBe(true);
  });

  it('puts a list in the project it names', async () => {
    const { project } = await acme();
    const view = await createList(k, { name: 'Release', target: { project }, kind: 'tracked' });
    expect(view.project.path).toBe('acme/website');
    expect(view.project.project.isDefault).toBe(false);
    expect((await k.listProjects(true)).some((p) => p.project.isDefault)).toBe(false);
  });

  it('finds the default project by its flag, not its name', async () => {
    const first = await createList(k, { name: 'One', target: personal });
    await k.db.update(t.projects).set({ name: 'Shelf', slug: 'shelf' }).where((await import('drizzle-orm')).eq(t.projects.id, first.project.project.id));
    const second = await createList(k, { name: 'Two', target: personal });
    expect(second.project.project.id).toBe(first.project.project.id);
    expect(second.project.path).toBe('personal/shelf');
  });

  it('allows only one default project per client', async () => {
    const view = await createList(k, { name: 'One', target: personal });
    const clientId = view.project.client.id;
    const err = await k.db
      .insert(t.projects)
      .values({ id: k.newId(), ...k.stamps(), refNo: 99, clientId, slug: 'second', name: 'Second', isDefault: true })
      .then(() => null, (e: unknown) => e);
    expect(`${err} ${(err as { cause?: unknown })?.cause}`).toMatch(/UNIQUE constraint failed/);
  });

  it('refuses an archived client', async () => {
    const { client } = await acme();
    await keel.run('client archive acme');
    client.archivedAt = k.iso(); // the client as a command would now read it
    await expect(createList(k, { name: 'Ideas', target: { client } })).rejects.toThrow(/archived/);
  });

  it('moves a list to another project', async () => {
    const { project } = await acme();
    const view = await createList(k, { name: 'Release', target: personal });
    const moved = await moveList(k, 'l1', { project });
    expect(moved.project.path).toBe('acme/website');
    await expect(moveList(k, 'l1', { project })).rejects.toThrow(/already in/);
    expect(view.list.id).toBe(moved.list.id);
  });
});

describe('creating and editing', () => {
  it('stores name, description, tags and kind, and checks them', async () => {
    const view = await createList(k, { name: '  D-mart  ', target: personal, kind: 'tracked', description: 'Weekly shop', tags: ['#Groceries', 'weekly', 'groceries'], pinned: true, items: ['milk', 'eggs'] });
    expect(view.list).toMatchObject({ name: 'D-mart', description: 'Weekly shop', tags: 'groceries weekly', kind: 'tracked', pinned: true, status: 'active', viewSort: 'manual' });
    expect(texts(view)).toEqual(['milk', 'eggs']);
    await expect(createList(k, { name: '  ', target: personal })).rejects.toThrow(/needs a name/);
    await expect(createList(k, { name: 'x', target: personal, tags: ['a', 'b', 'c', 'd', 'e', 'f'] })).rejects.toThrow(/up to 5 tags/);
    await expect(createList(k, { name: 'x', target: personal, tags: ['no spaces?'] })).rejects.toThrow(/can't be a tag/);
    await expect(createList(k, { name: 'x', target: personal, items: [' '] })).rejects.toThrow(/some text/);
  });

  it('updates only the fields given, and switching kind loses nothing', async () => {
    await createList(k, { name: 'Trip', target: personal, kind: 'tracked', items: ['passport', 'charger'] });
    await changeItems(k, 'l1', [(await findList(k, 'l1')).items[0]!.id], { state: 'done' });
    const plain = await updateList(k, 'l1', { kind: 'plain' });
    expect(plain.list.kind).toBe('plain');
    const back = await updateList(k, 'l1', { kind: 'tracked', description: 'Lisbon' });
    expect(back.list.description).toBe('Lisbon');
    expect(back.items.map((i) => i.state)).toEqual(['done', 'open']);
    expect(progressOf(back.items).label).toBe('1 of 2 done');
  });

  it('numbers lists l1, l2 ... and finds them by ref or id', async () => {
    const a = await createList(k, { name: 'A', target: personal });
    const b = await createList(k, { name: 'B', target: personal });
    expect([a.list.refNo, b.list.refNo]).toEqual([1, 2]);
    expect((await findList(k, 'L2')).list.name).toBe('B');
    expect((await findList(k, '2')).list.name).toBe('B');
    expect((await findList(k, a.list.id)).list.name).toBe('A');
    await expect(findList(k, 'l9')).rejects.toThrow(/No list l9/);
  });
});

describe('items, order and states', () => {
  it('adds items at the end, in order', async () => {
    await createList(k, { name: 'Groceries', target: personal, items: ['milk'] });
    const view = await addItems(k, 'l1', ['eggs', 'bread', 'rice']);
    expect(texts(view)).toEqual(['milk', 'eggs', 'bread', 'rice']);
    expect(view.items.every((i) => i.state === 'open')).toBe(true);
    await expect(addItems(k, 'l1', [])).rejects.toThrow(/Add what/);
  });

  it('counts "4 of 7 done" and offers reset or archive only when all are done', async () => {
    const view = await createList(k, { name: 'Release', target: personal, kind: 'tracked', items: ['a', 'b', 'c'] });
    expect(isComplete(view)).toBe(false);
    const ids = view.items.map((i) => i.id);
    const some = await changeItems(k, 'l1', ids.slice(0, 2), { state: 'done' });
    expect(progressOf(some.items)).toEqual({ done: 2, total: 3, label: '2 of 3 done' });
    expect(isComplete(some)).toBe(false);
    const all = await changeItems(k, 'l1', [ids[2]!], { state: 'done' });
    expect(isComplete(all)).toBe(true);
    // A plain list never offers it, and neither does an empty one.
    expect(isComplete({ list: { ...all.list, kind: 'plain' }, items: all.items })).toBe(false);
    expect(isComplete({ list: all.list, items: [] })).toBe(false);
  });

  it('sets the four states, and reopening clears the done time', async () => {
    const view = await createList(k, { name: 'Release', target: personal, kind: 'tracked', items: ['a'] });
    const id = view.items[0]!.id;
    for (const state of ['doing', 'blocked'] as const) expect((await changeItems(k, 'l1', [id], { state })).items[0]!.state).toBe(state);
    const done = await changeItems(k, 'l1', [id], { state: 'done' });
    expect(done.items[0]!.doneAt).toBe(now().toISOString());
    const reopened = await changeItems(k, 'l1', [id], { state: 'open' });
    expect(reopened.items[0]).toMatchObject({ state: 'open', doneAt: null });
    await expect(changeItems(k, 'l1', [id], { state: 'nope' as never })).rejects.toThrow(/open, doing, blocked, done/);
  });

  it('refuses an item already done, saying so (the first done wins)', async () => {
    const view = await createList(k, { name: 'Release', target: personal, kind: 'tracked', items: ['a', 'b'] });
    const [a, b] = view.items;
    await changeItems(k, 'l1', [a!.id], { state: 'done' });
    await expect(changeItems(k, 'l1', [a!.id], { state: 'done' })).rejects.toThrow(/already done/);
    // Nothing else in a refused batch is saved.
    await expect(changeItems(k, 'l1', [b!.id, a!.id], { state: 'done' })).rejects.toThrow(/already done/);
    expect((await findList(k, 'l1')).items.map((i) => i.state)).toEqual(['done', 'open']);
  });

  it('says what the other device did when two devices tick the same item', async () => {
    const view = await createList(k, { name: 'Release', target: personal, kind: 'tracked', items: ['a'] });
    const id = view.items[0]!.id;
    meanwhile(k, () => changeItems(k, 'l1', [id], { state: 'done' }));
    const err = await changeItems(k, 'l1', [id], { state: 'done' }).catch((e) => e);
    expect(err).toBeInstanceOf(Conflict);
    expect(err.message).toMatch(/was already done/);
    expect((await findList(k, 'l1')).items[0]!.state).toBe('done');
  });

  it('lets the last write win for other changes', async () => {
    const view = await createList(k, { name: 'Release', target: personal, kind: 'tracked', items: ['a'] });
    const id = view.items[0]!.id;
    meanwhile(k, () => changeItems(k, 'l1', [id], { state: 'blocked' }));
    await changeItems(k, 'l1', [id], { state: 'doing' });
    expect((await findList(k, 'l1')).items[0]!.state).toBe('doing');
  });

  it('edits an item and removes items', async () => {
    const view = await createList(k, { name: 'Groceries', target: personal, items: ['milk', 'eggs', 'bread'] });
    const [milk, eggs] = view.items;
    expect(texts(await changeItems(k, 'l1', [milk!.id], { text: 'oat milk', note: 'the blue one' }))).toEqual(['oat milk', 'eggs', 'bread']);
    expect((await findList(k, 'l1')).items[0]!.note).toBe('the blue one');
    expect(texts(await removeItems(k, 'l1', [eggs!.id]))).toEqual(['oat milk', 'bread']);
    await expect(removeItems(k, 'l1', [eggs!.id])).rejects.toThrow(/not in this list/);
    const now2 = await findList(k, 'l1');
    expect(itemAt(now2, 2).text).toBe('bread');
    expect(() => itemAt(now2, 3)).toThrow(/no item 3/);
    expect(() => itemAt(now2, 0)).toThrow(/no item 0/);
  });

  it('shows items by state, created or alpha without changing their stored order', async () => {
    const view = await createList(k, { name: 'Release', target: personal, kind: 'tracked', items: ['cherry', 'apple', 'banana', 'date'] });
    const [cherry, apple, banana] = view.items;
    await changeItems(k, 'l1', [apple!.id], { state: 'done' });
    await changeItems(k, 'l1', [cherry!.id], { state: 'doing' });
    await changeItems(k, 'l1', [banana!.id], { state: 'blocked' });
    const stored = texts(await findList(k, 'l1'));
    const by = async (viewSort: 'state' | 'alpha' | 'created' | 'manual') => texts({ items: shownItems(await updateList(k, 'l1', { viewSort })) });
    expect(await by('state')).toEqual(['cherry', 'banana', 'date', 'apple']); // doing, blocked, open, done
    expect(await by('alpha')).toEqual(['apple', 'banana', 'cherry', 'date']);
    expect(await by('manual')).toEqual(stored);
    // None of it rewrote the stored order.
    expect(texts(await findList(k, 'l1'))).toEqual(stored);
  });

  it('drags one item with one row written, and sets the list back to manual', async () => {
    const view = await createList(k, { name: 'Groceries', target: personal, items: ['a', 'b', 'c', 'd'] });
    await updateList(k, 'l1', { viewSort: 'alpha' });
    const [a, b, , d] = view.items;
    const before = view.items.map((i) => i.position);
    const moved = await moveItem(k, 'l1', d!.id, a!.id); // d after a
    expect(texts(moved)).toEqual(['a', 'd', 'b', 'c']);
    expect(moved.list.viewSort).toBe('manual');
    // Only d's position changed.
    const changed = moved.items.filter((i) => !view.items.some((o) => o.id === i.id && o.position === i.position));
    expect(changed.map((i) => i.text)).toEqual(['d']);
    expect(before).toContain(a!.position);
    expect(texts(await moveItem(k, 'l1', b!.id, null))).toEqual(['b', 'a', 'd', 'c']); // first
    expect(texts(await moveItem(k, 'l1', b!.id, (await findList(k, 'l1')).items.at(-1)!.id))).toEqual(['a', 'd', 'c', 'b']); // last
    await expect(moveItem(k, 'l1', b!.id, 'nope')).rejects.toThrow(/not in this list/);
  });

  it('merges drags from two devices, each moving a different item', async () => {
    const view = await createList(k, { name: 'Groceries', target: personal, items: ['a', 'b', 'c', 'd', 'e'] });
    const [a, b, c, d, e] = view.items;
    meanwhile(k, () => moveItem(k, 'l1', e!.id, a!.id)); // the other device: e after a
    await moveItem(k, 'l1', b!.id, d!.id); // this device: b after d
    expect(texts(await findList(k, 'l1'))).toEqual(['a', 'e', 'c', 'd', 'b']);
    expect(c).toBeDefined();
  });

  it('renumbers when two devices added at once and the keys tie', async () => {
    const view = await createList(k, { name: 'Groceries', target: personal, items: ['a'] });
    // Two items given the same key, like two devices appending to the same last item.
    const same = view.items[0]!.position;
    for (const text of ['x', 'y']) await k.db.insert(t.listItems).values({ id: k.newId(), ...k.stamps(), listId: view.list.id, position: `${same}`, text });
    const tied = await findList(k, 'l1');
    expect(new Set(tied.items.map((i) => i.position)).size).toBe(1);
    const moved = await moveItem(k, 'l1', tied.items[2]!.id, tied.items[0]!.id);
    expect(new Set(moved.items.map((i) => i.position)).size).toBe(3);
    expect(moved.items[1]!.id).toBe(tied.items[2]!.id);
  });

  it('keeps keys short when you keep adding one at a time', async () => {
    await createList(k, { name: 'Long', target: personal, items: ['first'] });
    for (let i = 0; i < 150; i++) await addItems(k, 'l1', [`item ${i}`]);
    const view = await findList(k, 'l1');
    expect(view.items).toHaveLength(151);
    expect(Math.max(...view.items.map((i) => i.position.length))).toBeLessThanOrEqual(24);
    expect(texts(view)[0]).toBe('first');
    expect(texts(view).slice(1)).toEqual(Array.from({ length: 150 }, (_, i) => `item ${i}`));
  }, 30_000);
});

describe('reset', () => {
  it('puts every item back to open and counts the reset', async () => {
    const view = await createList(k, { name: 'D-mart', target: personal, kind: 'tracked', items: ['milk', 'eggs', 'rice'] });
    const [milk, eggs] = view.items;
    await changeItems(k, 'l1', [milk!.id], { state: 'done' });
    await changeItems(k, 'l1', [eggs!.id], { state: 'blocked' });
    const { view: after, reset } = await resetList(k, 'l1');
    expect(reset).toBe(2);
    expect(after.items.map((i) => [i.state, i.doneAt])).toEqual([['open', null], ['open', null], ['open', null]]);
    expect(after.list).toMatchObject({ resetCount: 1, lastResetAt: now().toISOString() });
    expect((await k.db.select().from(t.events)).filter((e) => e.kind === 'reset')).toHaveLength(1);
  });

  it('does nothing when every item is already open, and refuses a plain list', async () => {
    await createList(k, { name: 'D-mart', target: personal, kind: 'tracked', items: ['milk'] });
    const { reset, view } = await resetList(k, 'l1');
    expect(reset).toBe(0);
    expect(view.list.resetCount).toBe(0);
    await createList(k, { name: 'Ideas', target: personal });
    await expect(resetList(k, 'l2')).rejects.toThrow(/plain list/);
  });
});

describe('browsing', () => {
  it('lists pinned first, then the most recently changed, and filters', async () => {
    const { project } = await acme();
    await createList(k, { name: 'Groceries', target: personal, tags: ['home', 'weekly'], description: 'The D-mart run' });
    await createList(k, { name: 'Release', target: { project }, kind: 'tracked', tags: ['work'] });
    await createList(k, { name: 'Trip', target: personal, pinned: true });
    expect((await listLists(k)).map((v) => v.list.name)).toEqual(['Trip', 'Release', 'Groceries']);
    expect((await listLists(k, { tag: '#home' })).map((v) => v.list.name)).toEqual(['Groceries']);
    expect((await listLists(k, { query: 'd-mart' })).map((v) => v.list.name)).toEqual(['Groceries']);
    expect((await listLists(k, { query: 'WORK' })).map((v) => v.list.name)).toEqual(['Release']);
    expect((await listLists(k, { projectId: project.project.id })).map((v) => v.list.name)).toEqual(['Release']);
    expect((await listLists(k, { clientId: (await k.clientBySlug('personal'))!.id })).map((v) => v.list.name)).toEqual(['Trip', 'Groceries']);
  });

  it('hides archived lists unless asked', async () => {
    await createList(k, { name: 'Old', target: personal });
    await createList(k, { name: 'New', target: personal });
    await updateList(k, 'l1', { status: 'archived' });
    expect((await listLists(k)).map((v) => v.list.name)).toEqual(['New']);
    expect((await listLists(k, { status: 'archived' })).map((v) => v.list.name)).toEqual(['Old']);
    expect(await listLists(k, { status: 'all' })).toHaveLength(2);
  });

  it('deletes a list with its items, softly', async () => {
    await createList(k, { name: 'Old', target: personal, items: ['a', 'b'] });
    await deleteList(k, 'l1');
    await expect(findList(k, 'l1')).rejects.toThrow(/No list/);
    expect(await listLists(k, { status: 'all' })).toHaveLength(0);
    // The rows are still there, for backups.
    expect((await k.db.select().from(t.lists))[0]!.deletedAt).not.toBeNull();
    expect((await k.db.select().from(t.listItems)).every((i) => i.deletedAt)).toBe(true);
  });
});

describe('covers', () => {
  it('sets a cover (and a dark one), counts the bytes, and clears it', async () => {
    await createList(k, { name: 'D-mart', target: personal });
    const { view, totalBytes, overNotice } = await setCover(k, 'l1', { kind: 'svg', data: SVG }, { kind: 'svg', data: SVG });
    expect(view.list).toMatchObject({ coverKind: 'svg', cover: SVG, coverDark: SVG });
    expect(totalBytes).toBe(2 * Buffer.byteLength(SVG));
    expect(await coverBytes(k)).toBe(totalBytes);
    expect(overNotice).toBe(false);
    const cleared = await setCover(k, 'l1', null);
    expect(cleared.view.list).toMatchObject({ coverKind: null, cover: null, coverDark: null });
    expect(cleared.totalBytes).toBe(0);
  });

  it('cleans an SVG before saving it, and refuses a mixed or dark-only pair', async () => {
    await createList(k, { name: 'D-mart', target: personal });
    const { view } = await setCover(k, 'l1', { kind: 'svg', data: SVG.replace('<rect', '<script>alert(1)</script><rect onclick="x()"') });
    expect(view.list.cover).toBe(SVG);
    await expect(setCover(k, 'l1', null, { kind: 'svg', data: SVG })).rejects.toThrow(/needs a regular one/);
    await expect(setCover(k, 'l1', { kind: 'svg', data: SVG }, { kind: 'png', data: 'iVBORw0KGgo=' })).rejects.toThrow(KeelError);
  });

  it('says when covers together pass the notice level (10 MB)', async () => {
    expect(COVER_STORAGE_NOTICE_BYTES).toBe(10 * 1024 * 1024);
    await createList(k, { name: 'D-mart', target: personal });
    await createList(k, { name: 'Other', target: personal });
    const size = Buffer.byteLength(SVG);
    // Lowered to a few covers' worth, since a real 10 MB would be fifty covers at the 200 KB cap.
    const at = size * 3;
    expect((await setCover(k, 'l1', { kind: 'svg', data: SVG }, null, at)).overNotice).toBe(false);
    expect((await setCover(k, 'l2', { kind: 'svg', data: SVG }, { kind: 'svg', data: SVG }, at)).overNotice).toBe(false); // exactly 3 covers
    const over = await setCover(k, 'l1', { kind: 'svg', data: SVG }, { kind: 'svg', data: SVG }, at);
    expect(over.totalBytes).toBe(size * 4);
    expect(over.overNotice).toBe(true);
    // The real level is not near.
    expect((await setCover(k, 'l1', { kind: 'svg', data: SVG })).overNotice).toBe(false);
  });
});
