import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { checkCover, COVER_STORAGE_NOTICE_BYTES, type Cover } from './covers';
import * as t from './db/schema';
import { Conflict, KeelError, NotFound } from './errors';
import { formatStamp } from './dates';
import { keyBetween, keysBetween, MAX_KEY_LENGTH } from './fractional';
import { CLIENT_HUES } from './palettes';
import type { Client, ProjectView, Store } from './store';

// ADR 0005: lists. A plain collection or a tracked checklist, always under a project.
// State changes follow ADR 0003: the first `done` wins (an item already done elsewhere
// is refused and says so), every other field is last arrival wins, a new list or item is
// a new row, and a drag writes one row (fractional keys, see fractional.ts).

export type List = typeof t.lists.$inferSelect;
export type ListItem = typeof t.listItems.$inferSelect;
export type ListKind = List['kind'];
export type ViewSort = List['viewSort'];
export type ItemState = ListItem['state'];

export const ITEM_STATES: readonly ItemState[] = ['open', 'doing', 'blocked', 'done'];
export const VIEW_SORTS: readonly ViewSort[] = ['manual', 'state', 'created', 'alpha'];

export const MAX_ITEMS = 1000;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 300;
const MAX_ITEM_TEXT = 500;
const MAX_TAGS = 5;
const MAX_TAG_LENGTH = 30;

export interface ListView {
  list: List;
  project: ProjectView;
  /** In stored (manual) order. Use `shownItems` for the order the list is set to show. */
  items: ListItem[];
}

/** "l3" for list 3. */
export const listRef = (list: Pick<List, 'refNo'>) => `l${list.refNo}`;

// ---- ordering and progress ----

/** The order `viewSort` asks for. Manual is the stored order; the others never change it. */
export function shownItems(view: Pick<ListView, 'list' | 'items'>): ListItem[] {
  const items = [...view.items];
  const rank: Record<ItemState, number> = { doing: 0, blocked: 1, open: 2, done: 3 };
  switch (view.list.viewSort) {
    case 'state':
      return items.sort((a, b) => rank[a.state] - rank[b.state] || cmp(a.position, b.position) || cmp(a.id, b.id));
    case 'created':
      return items.sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
    case 'alpha':
      return items.sort((a, b) => a.text.localeCompare(b.text, undefined, { sensitivity: 'base' }) || cmp(a.id, b.id));
    default:
      return items;
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface Progress {
  done: number;
  total: number;
  /** "4 of 7 done". */
  label: string;
}

/** Done over all items. Only meaningful for a tracked list (a plain one shows no progress). */
export function progressOf(items: Pick<ListItem, 'state'>[]): Progress {
  const done = items.filter((i) => i.state === 'done').length;
  return { done, total: items.length, label: `${done} of ${items.length} done` };
}

/** A tracked list with items, every one done: time to offer Reset or Archive (never automatic). */
export function isComplete(view: Pick<ListView, 'list' | 'items'>): boolean {
  return view.list.kind === 'tracked' && view.list.status === 'active' && view.items.length > 0 && view.items.every((i) => i.state === 'done');
}

export const tagList = (list: Pick<List, 'tags'>): string[] => (list.tags ? list.tags.split(' ') : []);

// ---- checking input ----

const clean = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null);

/** Tags as stored: lowercase, no `#`, no repeats. */
export function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.replace(/^#/, '').trim().toLowerCase();
    if (!tag) continue;
    if (!/^[\p{L}\p{N}_-]+$/u.test(tag)) throw new KeelError(`"${raw}" can't be a tag.`, 'Use letters, numbers, - or _, like #groceries.', 'tags');
    if (tag.length > MAX_TAG_LENGTH) throw new KeelError(`The tag "${tag}" is too long.`, `Keep tags under ${MAX_TAG_LENGTH} characters.`, 'tags');
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS) throw new KeelError(`A list takes up to ${MAX_TAGS} tags.`, 'Keep the few that you would search by.', 'tags');
  return out;
}

export interface ListFields {
  name?: string;
  description?: string | null;
  tags?: string[];
  kind?: ListKind;
  viewSort?: ViewSort;
  pinned?: boolean;
}

function checkFields(fields: ListFields): void {
  if (fields.name !== undefined) {
    if (!clean(fields.name)) throw new KeelError('A list needs a name.', 'For example: D-mart groceries', 'name');
    if (fields.name.trim().length > MAX_NAME) throw new KeelError('That name is too long.', `Keep it under ${MAX_NAME} characters.`, 'name');
  }
  if (fields.description && fields.description.trim().length > MAX_DESCRIPTION) {
    throw new KeelError('That description is too long.', `Keep it under ${MAX_DESCRIPTION} characters.`, 'description');
  }
  if (fields.kind !== undefined && fields.kind !== 'plain' && fields.kind !== 'tracked') throw new KeelError(`A list is plain or tracked, not "${String(fields.kind)}".`, undefined, 'kind');
  if (fields.viewSort !== undefined && !VIEW_SORTS.includes(fields.viewSort)) {
    throw new KeelError(`Sort a list by ${VIEW_SORTS.join(', ')}, not "${String(fields.viewSort)}".`, undefined, 'viewSort');
  }
}

function checkItemText(text: string, field = 'text'): string {
  const trimmed = text.trim();
  if (!trimmed) throw new KeelError('An item needs some text.', undefined, field);
  if (trimmed.length > MAX_ITEM_TEXT) throw new KeelError('That item is too long.', `Keep it under ${MAX_ITEM_TEXT} characters.`, field);
  return trimmed;
}

// ---- reading ----

async function projectMap(k: Store): Promise<Map<string, ProjectView>> {
  return new Map((await k.listProjects(true)).map((pv) => [pv.project.id, pv]));
}

async function itemsOf(k: Store, listId: string): Promise<ListItem[]> {
  return k.db
    .select()
    .from(t.listItems)
    .where(and(eq(t.listItems.listId, listId), isNull(t.listItems.deletedAt)))
    .orderBy(asc(t.listItems.position), asc(t.listItems.id));
}

/** By ref ("l3", "3") or id. A deleted list is not found. */
export async function findList(k: Store, ref: string): Promise<ListView> {
  const n = /^l?(\d+)$/i.exec(ref.trim());
  const where = n ? eq(t.lists.refNo, Number(n[1])) : eq(t.lists.id, ref);
  const [list] = await k.db.select().from(t.lists).where(and(where, isNull(t.lists.deletedAt)));
  const project = list ? (await projectMap(k)).get(list.projectId) : undefined;
  if (!list || !project) throw new NotFound(`No list ${n ? `l${n[1]}` : `"${ref}"`}.`, 'See your lists with: keel list');
  return { list, project, items: await itemsOf(k, list.id) };
}

export interface ListFilter {
  /** `active` (the default), `archived`, or `all`. */
  status?: 'active' | 'archived' | 'all';
  projectId?: string;
  /** Lists under any project of this client. */
  clientId?: string;
  tag?: string;
  /** Matches the name, description and tags. */
  query?: string;
}

/** Pinned first, then the most recently changed. */
export async function listLists(k: Store, filter: ListFilter = {}): Promise<ListView[]> {
  const status = filter.status ?? 'active';
  const rows = await k.db
    .select()
    .from(t.lists)
    .where(and(isNull(t.lists.deletedAt), status === 'all' ? undefined : eq(t.lists.status, status), filter.projectId ? eq(t.lists.projectId, filter.projectId) : undefined));
  if (!rows.length) return [];
  const projects = await projectMap(k);
  const items = await k.db
    .select()
    .from(t.listItems)
    .where(and(inArray(t.listItems.listId, rows.map((l) => l.id)), isNull(t.listItems.deletedAt)))
    .orderBy(asc(t.listItems.position), asc(t.listItems.id));
  const query = filter.query?.trim().toLowerCase();
  const tag = filter.tag?.replace(/^#/, '').toLowerCase();
  return rows
    .filter((l) => projects.has(l.projectId))
    .filter((l) => !filter.clientId || projects.get(l.projectId)!.client.id === filter.clientId)
    .filter((l) => !tag || tagList(l).includes(tag))
    .filter((l) => !query || [l.name, l.description ?? '', l.tags ?? ''].some((text) => text.toLowerCase().includes(query)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || cmp(b.updatedAt, a.updatedAt) || b.refNo - a.refNo)
    .map((list) => ({ list, project: projects.get(list.projectId)!, items: items.filter((i) => i.listId === list.id) }));
}

/** How many live lists each project holds (for hiding an empty default project). */
export async function listCountsByProject(k: Store): Promise<Map<string, number>> {
  const rows = await k.db
    .select({ projectId: t.lists.projectId, n: sql<number>`count(*)` })
    .from(t.lists)
    .where(isNull(t.lists.deletedAt))
    .groupBy(t.lists.projectId);
  return new Map(rows.map((r) => [r.projectId, Number(r.n)]));
}

/** The nth item (1-based, in stored order). */
export function itemAt(view: Pick<ListView, 'list' | 'items'>, n: number): ListItem {
  const item = view.items[n - 1];
  if (!Number.isInteger(n) || !item) {
    throw new NotFound(`${listRef(view.list)} has no item ${n}.`, view.items.length ? `It has ${view.items.length}: keel list show ${listRef(view.list)}` : `It is empty. Add one with: keel list add ${listRef(view.list)} "..."`);
  }
  return item;
}

// ---- where a list goes: the default project ----

export const PERSONAL_SLUG = 'personal';
export const DEFAULT_PROJECT_SLUG = 'general';

export type Target = { project: ProjectView } | { client: Client } | { personal: true };

/**
 * The project a list lands in, plus what must be written first when the Personal client
 * or a client's General project does not exist yet. Found by `isDefault`, never by name.
 */
export async function shelfFor(k: Store, target: Target): Promise<{ projectId: string; project: ProjectView | null; queries: any[] }> {
  if ('project' in target) return { projectId: target.project.project.id, project: target.project, queries: [] };
  const queries: any[] = [];
  let client: Client;
  let clientId: string;
  if ('client' in target) {
    client = target.client;
    clientId = client.id;
    if (client.archivedAt) throw new KeelError(`${client.slug} is archived.`, `Bring it back first: client unarchive ${client.slug}`);
  } else {
    const existing = await k.clientBySlug(PERSONAL_SLUG);
    if (existing) {
      client = existing;
      clientId = existing.id;
      if (existing.archivedAt) throw new KeelError('Your Personal client is archived.', 'Bring it back first: client unarchive personal');
    } else {
      clientId = k.newId();
      const color = CLIENT_HUES[(await k.listClients(true)).length % CLIENT_HUES.length]!;
      queries.push(k.db.insert(t.clients).values({ id: clientId, ...k.stamps(), slug: PERSONAL_SLUG, name: 'Personal', color }), k.event('client', clientId, 'created', { by: 'lists' }));
      client = { id: clientId, slug: PERSONAL_SLUG, name: 'Personal', color } as Client;
    }
  }
  const known = (await k.listProjects(true)).filter((pv) => pv.client.id === clientId);
  const shelf = known.find((pv) => pv.project.isDefault);
  if (shelf) return { projectId: shelf.project.id, project: shelf, queries };
  const id = k.newId();
  const taken = new Set(known.map((pv) => pv.project.slug));
  const slug = !taken.has(DEFAULT_PROJECT_SLUG) ? DEFAULT_PROJECT_SLUG : `${DEFAULT_PROJECT_SLUG}-lists`;
  queries.push(
    k.db.insert(t.projects).values({ id, ...k.stamps(), refNo: await k.nextRef(t.projects), clientId, slug, name: 'General', isDefault: true }),
    k.event('project', id, 'created', { by: 'lists', default: true }),
  );
  return { projectId: id, project: null, queries };
}

// ---- writing ----

export interface NewList {
  name: string;
  target: Target;
  kind?: ListKind;
  description?: string | null;
  tags?: string[];
  pinned?: boolean;
  items?: string[];
}

export async function createList(k: Store, input: NewList): Promise<ListView> {
  checkFields({ name: input.name, description: input.description, kind: input.kind });
  const tags = normalizeTags(input.tags ?? []);
  const texts = (input.items ?? []).map((text) => checkItemText(text, 'items'));
  if (texts.length > MAX_ITEMS) throw new KeelError(`A list takes up to ${MAX_ITEMS} items.`, undefined, 'items');
  const id = k.newId();
  const keys = keysBetween(null, null, texts.length);

  const build = async () => {
    const shelf = await shelfFor(k, input.target);
    const refNo = await k.nextRef(t.lists);
    await k.batch([
      ...shelf.queries,
      k.db.insert(t.lists).values({
        id,
        ...k.stamps(),
        refNo,
        projectId: shelf.projectId,
        name: input.name.trim(),
        description: clean(input.description),
        tags: tags.length ? tags.join(' ') : null,
        kind: input.kind ?? 'plain',
        pinned: input.pinned ?? false,
      }),
      ...texts.map((text, i) => k.db.insert(t.listItems).values({ id: k.newId(), ...k.stamps(), listId: id, position: keys[i]!, text })),
      k.event('list', id, 'created', { ref: `l${refNo}`, name: input.name.trim(), kind: input.kind ?? 'plain', items: texts.length }),
    ]);
  };
  try {
    await build();
  } catch (e) {
    // Another device made the same Personal client or General project, or took this ref, a moment earlier: look again once.
    if (!/UNIQUE|constraint/i.test(`${e instanceof Error ? e.message : e} ${(e as { cause?: unknown })?.cause ?? ''}`)) throw e;
    await build();
  }
  return findList(k, id);
}

/** Last arrival wins, per field: only the fields given are written. */
export async function updateList(k: Store, ref: string, fields: ListFields & { status?: List['status'] }): Promise<ListView> {
  const view = await findList(k, ref);
  checkFields(fields);
  const set: Partial<typeof t.lists.$inferInsert> = {};
  if (fields.name !== undefined) set.name = fields.name.trim();
  if (fields.description !== undefined) set.description = clean(fields.description);
  if (fields.tags !== undefined) {
    const tags = normalizeTags(fields.tags);
    set.tags = tags.length ? tags.join(' ') : null;
  }
  if (fields.kind !== undefined) set.kind = fields.kind;
  if (fields.viewSort !== undefined) set.viewSort = fields.viewSort;
  if (fields.pinned !== undefined) set.pinned = fields.pinned;
  if (fields.status !== undefined) set.status = fields.status;
  if (!Object.keys(set).length) return view;
  await writeList(k, view, set, 'edited', { fields: Object.keys(set) });
  return findList(k, view.list.id);
}

async function writeList(k: Store, view: ListView, set: Partial<typeof t.lists.$inferInsert>, kind: string, payload: unknown, extra: any[] = []): Promise<void> {
  try {
    await k.batch([
      ...k.guarded(k.db.update(t.lists).set({ ...set, updatedAt: k.iso() }).where(and(eq(t.lists.id, view.list.id), isNull(t.lists.deletedAt)))),
      ...extra,
      k.event('list', view.list.id, kind, payload),
    ]);
  } catch (e) {
    if (e instanceof Conflict) throw new Conflict(`${listRef(view.list)} was deleted on another device.`, '');
    throw e;
  }
}

/** Moves a list to another project (or a client's General project, or Personal). */
export async function moveList(k: Store, ref: string, target: Target): Promise<ListView> {
  const view = await findList(k, ref);
  const shelf = await shelfFor(k, target);
  if (shelf.projectId === view.list.projectId) throw new KeelError(`${listRef(view.list)} is already in ${view.project.path}.`);
  await writeList(k, view, { projectId: shelf.projectId }, 'moved', { from: view.project.path }, shelf.queries);
  return findList(k, view.list.id);
}

/** Soft delete: the list and its items disappear; daily backups and exports from before still have them. */
export async function deleteList(k: Store, ref: string): Promise<ListView> {
  const view = await findList(k, ref);
  const at = k.iso();
  await k.batch([
    k.db.update(t.listItems).set({ deletedAt: at, updatedAt: at }).where(and(eq(t.listItems.listId, view.list.id), isNull(t.listItems.deletedAt))),
    k.db.update(t.lists).set({ deletedAt: at, updatedAt: at }).where(eq(t.lists.id, view.list.id)),
    k.event('list', view.list.id, 'deleted', { name: view.list.name, items: view.items.length }),
  ]);
  return view;
}

// ---- items ----

/** Adds items at the end. A new row each, so two devices adding at once never conflict. */
export async function addItems(k: Store, ref: string, texts: string[]): Promise<ListView> {
  const view = await findList(k, ref);
  const items = texts.map((text) => checkItemText(text));
  if (!items.length) throw new KeelError('Add what?', `Example: keel list add ${listRef(view.list)} item:milk item:eggs`, 'items');
  if (view.items.length + items.length > MAX_ITEMS) throw new KeelError(`A list takes up to ${MAX_ITEMS} items.`, undefined, 'items');
  const keys = keysBetween(view.items.at(-1)?.position ?? null, null, items.length);
  const tooLong = keys.some((key) => key.length > MAX_KEY_LENGTH);
  const at = k.iso();
  const order = view.items.map((i) => i.id);
  const added = items.map((text, i) => ({ id: k.newId(), text, key: keys[i]! }));
  const queries: any[] = added.map((a) => k.db.insert(t.listItems).values({ id: a.id, ...k.stamps(), listId: view.list.id, position: a.key, text: a.text }));
  // Keys that have grown long: renumber the whole list in the same batch.
  if (tooLong) {
    const all = [...order, ...added.map((a) => a.id)];
    const fresh = keysBetween(null, null, all.length);
    queries.push(
      ...all.map((id, i) => k.db.update(t.listItems).set({ position: fresh[i]!, updatedAt: at }).where(eq(t.listItems.id, id))),
    );
  }
  await k.batch([...queries, k.db.update(t.lists).set({ updatedAt: at }).where(eq(t.lists.id, view.list.id)), k.event('list', view.list.id, 'items added', { count: items.length })]);
  return findList(k, view.list.id);
}

export interface ItemChange {
  text?: string;
  note?: string | null;
  state?: ItemState;
}

/**
 * Changes items by id. `done` is guarded (the first close wins): an item already done on
 * another device is refused and says when. Other changes are last arrival wins.
 */
export async function changeItems(k: Store, ref: string, ids: string[], change: ItemChange): Promise<ListView> {
  const view = await findList(k, ref);
  if (change.state !== undefined && !ITEM_STATES.includes(change.state)) throw new KeelError(`An item is ${ITEM_STATES.join(', ')}, not "${String(change.state)}".`, undefined, 'state');
  if (change.text !== undefined) checkItemText(change.text);
  const picked = ids.map((id) => {
    const item = view.items.find((i) => i.id === id);
    if (!item) throw new NotFound('That item is not in this list (it may have been removed).', `See it with: keel list show ${listRef(view.list)}`);
    return item;
  });
  const at = k.iso();
  const set: Partial<typeof t.listItems.$inferInsert> = { updatedAt: at };
  if (change.text !== undefined) set.text = change.text.trim();
  if (change.note !== undefined) set.note = clean(change.note);
  if (change.state !== undefined) {
    set.state = change.state;
    set.doneAt = change.state === 'done' ? at : null;
  }
  const closing = change.state === 'done';
  const queries: any[] = [];
  for (const item of picked) {
    if (closing && item.state === 'done') throw alreadyDone(view.list, item, k.today());
    const where = and(eq(t.listItems.id, item.id), isNull(t.listItems.deletedAt), closing ? ne(t.listItems.state, 'done') : undefined);
    queries.push(...(closing ? k.guarded(k.db.update(t.listItems).set(set).where(where)) : [k.db.update(t.listItems).set(set).where(where)]));
  }
  try {
    await k.batch([...queries, k.db.update(t.lists).set({ updatedAt: at }).where(eq(t.lists.id, view.list.id)), k.event('list', view.list.id, 'items changed', { count: picked.length, ...change })]);
  } catch (e) {
    if (!(e instanceof Conflict)) throw e;
    // Say what the other device did.
    const now = await findList(k, view.list.id).catch(() => null);
    if (!now) throw new Conflict(`${listRef(view.list)} was deleted on another device.`, '');
    for (const item of picked) {
      const fresh = now.items.find((i) => i.id === item.id);
      if (!fresh) throw new Conflict('An item was removed on another device, so nothing was saved.', 'Look again and retry if it still applies.');
      if (closing && fresh.state === 'done') throw alreadyDone(now.list, fresh, k.today());
    }
    throw e;
  }
  return findList(k, view.list.id);
}

function alreadyDone(list: List, item: ListItem, today: string): KeelError {
  const when = item.doneAt ? ` on ${formatStamp(item.doneAt, today)}` : '';
  return new Conflict(`"${item.text}" in ${listRef(list)} was already done${when}.`, '');
}

export async function removeItems(k: Store, ref: string, ids: string[]): Promise<ListView> {
  const view = await findList(k, ref);
  const picked = ids.map((id) => {
    const item = view.items.find((i) => i.id === id);
    if (!item) throw new NotFound('That item is not in this list (it may have been removed).');
    return item;
  });
  const at = k.iso();
  await k.batch([
    k.db.update(t.listItems).set({ deletedAt: at, updatedAt: at }).where(inArray(t.listItems.id, picked.map((i) => i.id))),
    k.db.update(t.lists).set({ updatedAt: at }).where(eq(t.lists.id, view.list.id)),
    k.event('list', view.list.id, 'items removed', { count: picked.length }),
  ]);
  return findList(k, view.list.id);
}

/**
 * Puts an item at a place in the stored order: after the item `afterId` (null: first).
 * Writes one row; the list is set back to manual order, since a drag means "this order".
 */
export async function moveItem(k: Store, ref: string, itemId: string, afterId: string | null): Promise<ListView> {
  const view = await findList(k, ref);
  const item = view.items.find((i) => i.id === itemId);
  if (!item) throw new NotFound('That item is not in this list (it may have been removed).');
  if (afterId === itemId) return view;
  const others = view.items.filter((i) => i.id !== itemId);
  const index = afterId === null ? 0 : others.findIndex((i) => i.id === afterId) + 1;
  if (afterId !== null && index === 0) throw new NotFound('The item to place it after is not in this list.');
  const before = others[index - 1]?.position ?? null;
  const after = others[index]?.position ?? null;
  const at = k.iso();

  let positions: Array<[string, string]>;
  // Equal keys (two devices appended at once) or a long one: renumber the whole list.
  const key = before !== null && after !== null && before >= after ? null : keyBetween(before, after);
  if (key === null || key.length > MAX_KEY_LENGTH) {
    const order = [...others.slice(0, index), item, ...others.slice(index)];
    const fresh = keysBetween(null, null, order.length);
    positions = order.map((i, n): [string, string] => [i.id, fresh[n]!]);
  } else {
    positions = [[item.id, key]];
  }
  await k.batch([
    ...positions.map(([id, position]) => k.db.update(t.listItems).set({ position, updatedAt: at }).where(and(eq(t.listItems.id, id), isNull(t.listItems.deletedAt)))),
    k.db.update(t.lists).set({ viewSort: 'manual', updatedAt: at }).where(eq(t.lists.id, view.list.id)),
    k.event('list', view.list.id, 'item moved', { renumbered: positions.length > 1 }),
  ]);
  return findList(k, view.list.id);
}

/** Every item back to open, for a list you use again. Tracked lists only. */
export async function resetList(k: Store, ref: string): Promise<{ view: ListView; reset: number }> {
  const view = await findList(k, ref);
  if (view.list.kind !== 'tracked') throw new KeelError(`${listRef(view.list)} is a plain list, so it has nothing to reset.`, `Make it tracked first: keel list set ${listRef(view.list)} kind:tracked`);
  const touched = view.items.filter((i) => i.state !== 'open');
  if (!touched.length) return { view, reset: 0 };
  const at = k.iso();
  await k.batch([
    k.db.update(t.listItems).set({ state: 'open', doneAt: null, updatedAt: at }).where(and(eq(t.listItems.listId, view.list.id), ne(t.listItems.state, 'open'), isNull(t.listItems.deletedAt))),
    k.db.update(t.lists).set({ resetCount: view.list.resetCount + 1, lastResetAt: at, updatedAt: at }).where(eq(t.lists.id, view.list.id)),
    k.event('list', view.list.id, 'reset', { items: touched.length }),
  ]);
  return { view: await findList(k, view.list.id), reset: touched.length };
}

// ---- covers ----

/** All covers together, in bytes. */
export async function coverBytes(k: Store): Promise<number> {
  const [row] = await k.db
    .select({ n: sql<number>`coalesce(sum(length(cast(${t.lists.cover} as blob)) + coalesce(length(cast(${t.lists.coverDark} as blob)), 0)), 0)` })
    .from(t.lists)
    .where(isNull(t.lists.deletedAt));
  return Number(row?.n ?? 0);
}

/** Sets or clears a list's cover. Returns the total size, and whether it passed the notice level. */
export async function setCover(
  k: Store,
  ref: string,
  cover: Cover | null,
  dark: Cover | null = null,
  /** Where "covers are taking a lot of space" starts; 10 MB unless a test lowers it. */
  noticeAt = COVER_STORAGE_NOTICE_BYTES,
): Promise<{ view: ListView; totalBytes: number; overNotice: boolean }> {
  const view = await findList(k, ref);
  if (cover) cover = checkCover(cover.kind, cover.data);
  if (dark) {
    if (!cover) throw new KeelError('A dark cover needs a regular one too.', undefined, 'coverDark');
    dark = checkCover(dark.kind, dark.data);
    if (dark.kind !== cover.kind) throw new KeelError('The light and dark covers must both be SVG, or both PNG.', undefined, 'coverDark');
  }
  await writeList(k, view, { coverKind: cover?.kind ?? null, cover: cover?.data ?? null, coverDark: dark?.data ?? null }, cover ? 'cover set' : 'cover cleared', { kind: cover?.kind ?? null, dark: Boolean(dark) });
  const totalBytes = await coverBytes(k);
  return { view: await findList(k, view.list.id), totalBytes, overNotice: totalBytes > noticeAt };
}
