import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { blank, data, heading, hint, line, ok, s, table, warn, type Block, type Span, type Tone } from '../blocks';
import { checkCover, coverFromBytes, formatBytes, type Cover } from '../covers';
import { KeelError } from '../errors';
import {
  addItems,
  changeItems,
  createList,
  deleteList,
  findList,
  isComplete,
  ITEM_STATES,
  itemAt,
  listLists,
  listRef,
  moveItem,
  moveList,
  progressOf,
  removeItems,
  resetList,
  setCover,
  shownItems,
  tagList,
  updateList,
  VIEW_SORTS,
  type ItemState,
  type ListFields,
  type ListKind,
  type ListView,
  type Target,
  type ViewSort,
} from '../lists';
import type { Parsed } from '../parse';
import { formatStamp } from '../dates';
import type { Store } from '../store';
import { listData, projectSpan, type Command, type Flow } from './shared';

// ADR 0005. `list` with no subcommand shows every list, like `goal` shows every goal.
// Items are named by their number in the list (the # column of `list show`, in stored
// order), so numbers stay put while the list is shown sorted another way.

const USAGE = [
  'list [ls] [--archived|--all] [#tag] [+client[/project]] [words]',
  'list new "<name>" [--tracked] [--pin] [desc:"..."] [item:"..."] [#tag ...] [+client/project]',
  'list show l1',
  'list add l1 item:"milk" [item:"eggs" ...]',
  'list done l1 1 2 4-6',
  'list state l1 3 blocked',
  'list edit l1 3 "new text" [note:"..."]',
  'list rm l1 3',
  'list order l1 3 to 1',
  'list set l1 [name:"..."] [desc:"..."] [kind:plain|tracked] [sort:manual|state|created|alpha] [#tag ...]',
  'list reset l1 [--yes]',
  'list archive|unarchive|pin|unpin l1',
  'list move l1 +client[/project]',
  'list cover l1 <file.svg|file.png> [dark:<file>] | list cover l1 --clear',
  'list delete l1 [--yes]',
].join(' | ');

export const list: Command = {
  name: 'list',
  usage: USAGE,
  summary: 'Keep plain lists and tracked checklists, under a project',
  async *flow(k, p) {
    const sub = (p.words[0] ?? 'ls').toLowerCase();
    switch (sub) {
      case 'ls':
      case 'list':
        return browse(k, p);
      case 'new':
        return newList(k, p);
      case 'show':
        return showList(k, refOf(p, 'show'));
      case 'add':
        return add(k, p);
      case 'done':
        return setState(k, p, 'done');
      case 'state':
        return setState(k, p, null);
      case 'edit':
        return edit(k, p);
      case 'rm':
      case 'remove':
        return remove(k, p);
      case 'order':
        return order(k, p);
      case 'set':
        return set(k, p);
      case 'reset':
        return yield* reset(k, p);
      case 'archive':
      case 'unarchive':
        return archive(k, p, sub === 'archive');
      case 'pin':
      case 'unpin':
        return pin(k, p, sub === 'pin');
      case 'move':
        return move(k, p);
      case 'cover':
        return cover(k, p);
      case 'delete':
        return yield* del(k, p);
      default:
        throw new KeelError(`Unknown "list ${sub}".`, 'Try: list, list new "D-mart" --tracked, list show l1, list add l1 item:milk, list done l1 1, list reset l1');
    }
  },
};

// ---- reading the command line ----

interface Words {
  /** Plain words in order, with whether each was quoted. */
  words: Array<{ text: string; quoted: boolean }>;
  /** `key:value` parts for the keys asked for. Each key can repeat. */
  fields: Record<string, string[]>;
}

const SPECIAL = /^(@[\w.-]+|\+[a-z0-9][\w-]*(\/[a-z0-9][\w-]*)?|#[\w-]+|--[a-z][\w-]*)$/i;

/** Splits the tokens after the subcommand into words and the given `key:value` fields. */
function split(p: Parsed, keys: string[], skip = 1): Words {
  const out: Words = { words: [], fields: {} };
  let seen = 0;
  for (const tok of p.raw) {
    if (!tok.quoted && SPECIAL.test(tok.text)) continue;
    const kv = tok.quoted ? null : /^([a-z]+):(.*)$/s.exec(tok.text);
    if (kv && keys.includes(kv[1]!)) {
      (out.fields[kv[1]!] ??= []).push(kv[2] ?? '');
      continue;
    }
    if (seen++ < skip) continue; // the subcommand itself
    out.words.push({ text: tok.text, quoted: tok.quoted });
  }
  return out;
}

function refOf(p: Parsed, sub: string, at = 1): string {
  const word = p.words[at];
  if (!word || !/^l?\d+$/i.test(word)) throw new KeelError('Which list?', `Example: list ${sub} l1. See your lists with: list`);
  return word;
}

/** `3`, `2-4` and `7` as item numbers, without repeats. */
function numbers(words: string[], sub: string): number[] {
  const out: number[] = [];
  for (const w of words) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(w);
    if (!m) throw new KeelError(`"${w}" isn't an item number.`, `Use the numbers from list show: list ${sub} l1 1 2 4-6`);
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (to < from || to - from > 1000) throw new KeelError(`"${w}" isn't a range.`, 'Like 4-6.');
    for (let n = from; n <= to; n++) if (!out.includes(n)) out.push(n);
  }
  if (!out.length) throw new KeelError('Which items?', `Give their numbers, like: list ${sub} l1 1 2 4-6`);
  return out;
}

/** The project a list goes to: the one named with +client/project, a client's General project, the one you are working in, or Personal. */
async function targetOf(k: Store, p: Parsed): Promise<Target> {
  const named = p.projects[0];
  if (named) {
    if (named.includes('/')) return { project: await k.projectByPath(named) };
    const client = await k.clientBySlug(named);
    if (client) return { client };
    if (named === 'personal') return { personal: true };
    throw new KeelError(`No client ${named}.`, 'List them with: clients --all');
  }
  const ctx = await k.contextProject();
  return ctx ? { project: ctx } : { personal: true };
}

const kindOf = (value: string): ListKind => {
  const v = value.trim().toLowerCase();
  if (v !== 'plain' && v !== 'tracked') throw new KeelError(`A list is plain or tracked, not "${value}".`, 'Example: list set l1 kind:tracked');
  return v;
};

const sortOf = (value: string): ViewSort => {
  const v = value.trim().toLowerCase() as ViewSort;
  if (!VIEW_SORTS.includes(v)) throw new KeelError(`Sort a list by ${VIEW_SORTS.join(', ')}, not "${value}".`, 'Example: list set l1 sort:state');
  return v;
};

// ---- showing ----

const STATE_GLYPH: Record<ItemState, [string, Tone]> = { open: ['○', 'muted'], doing: ['◐', 'today'], blocked: ['⊘', 'late'], done: ['✓', 'done'] };
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function nameRow(view: ListView): Span[] {
  const ref = listRef(view.list);
  return [s(view.list.pinned ? '★' : ' ', 'today'), s(ref, 'muted', { ref }), s(view.list.name, 'default', { bold: view.list.pinned })];
}

async function browse(k: Store, p: Parsed): Promise<Block[]> {
  const status = p.flags.has('all') ? 'all' : p.flags.has('archived') ? 'archived' : 'active';
  const scope = p.projects[0];
  let filter: Parameters<typeof listLists>[1] = { status };
  if (scope) {
    if (scope.includes('/')) filter = { ...filter, projectId: (await k.projectByPath(scope)).project.id };
    else filter = { ...filter, clientId: (await k.requireClient(scope, 'Example: list +acme')).id };
  }
  const query = split(p, [], 1).words.map((w) => w.text).join(' ');
  const views = await listLists(k, { ...filter, tag: p.tags[0], query: query || undefined });
  const hiddenArchived = status === 'active' ? (await listLists(k, { status: 'archived' })).length : 0;
  if (!views.length) {
    return [
      hint(p.tags.length || query || scope ? 'No lists match.' : status === 'archived' ? 'No archived lists.' : 'No lists yet. Start one: list new "D-mart" --tracked'),
      ...(hiddenArchived ? [hint(`${hiddenArchived} archived: list --archived`)] : []),
      data({ lists: [] }),
    ];
  }
  return [
    heading(`LISTS · ${views.length}`),
    table(
      views.map((v) => [
        ...nameRow(v),
        v.list.kind === 'tracked' ? s(progressOf(v.items).label, isComplete(v) ? 'done' : 'muted') : s(plural(v.items.length, 'item'), 'muted'),
        projectSpan(v.project),
        s(tagList(v.list).map((x) => `#${x}`).join(' '), 'muted'),
        ...(v.list.status === 'archived' ? [s('archived', 'dim')] : []),
      ]),
    ),
    ...(hiddenArchived ? [hint(`${hiddenArchived} archived. Show them with: list --archived`)] : []),
    data({ lists: views.map(listData) }),
  ];
}

export async function showList(k: Store, ref: string): Promise<Block[]> {
  const view = await findList(k, ref);
  const { list } = view;
  const tracked = list.kind === 'tracked';
  const progress = progressOf(view.items);
  const lines: Span[][] = [
    [s('project', 'muted'), projectSpan(view.project)],
    ...(list.description ? [[s('about', 'muted'), s(list.description)]] : []),
    ...(list.tags ? [[s('tags', 'muted'), s(tagList(list).map((x) => `#${x}`).join(' '))]] : []),
    [s('kind', 'muted'), s(tracked ? `tracked · ${progress.label}` : 'plain')],
    ...(list.viewSort !== 'manual' ? [[s('shown', 'muted'), s(`sorted by ${list.viewSort}`)]] : []),
    ...(list.resetCount ? [[s('reset', 'muted'), s(`${plural(list.resetCount, 'time')}, last ${formatStamp(list.lastResetAt!, k.today())}`)]] : []),
    ...(list.coverKind ? [[s('cover', 'muted'), s(`${list.coverKind.toUpperCase()}${list.coverDark ? ', light and dark' : ''} · ${formatBytes(Buffer.byteLength(list.cover ?? '') + Buffer.byteLength(list.coverDark ?? ''))}`)]] : []),
    ...(list.status === 'archived' ? [[s('status', 'muted'), s('archived', 'dim')]] : []),
  ];
  const shown = shownItems(view);
  const number = (id: string) => view.items.findIndex((i) => i.id === id) + 1;
  return [
    line([s(`${listRef(list)}  `, 'muted'), s(list.name, 'default', { bold: true }), ...(list.pinned ? [s(' ★', 'today')] : [])]),
    table(lines, 2),
    blank(),
    heading(`ITEMS · ${view.items.length}`, 'muted'),
    ...(shown.length
      ? [
          table(
            shown.map((i) => {
              const [glyph, tone] = tracked ? STATE_GLYPH[i.state] : ['·', 'muted' as Tone];
              return [s(String(number(i.id)), 'muted'), s(glyph, tone), s(i.text, tracked && i.state === 'done' ? 'dim' : 'default'), ...(i.note ? [s(i.note, 'dim')] : []), ...(tracked && (i.state === 'doing' || i.state === 'blocked') ? [s(i.state, tone)] : [])];
            }),
          ),
        ]
      : [hint(`Empty. Add items with: list add ${listRef(list)} item:milk item:eggs`)]),
    ...(isComplete(view) ? [completeHint(view)] : []),
    data(listData(view)),
  ];
}

const completeHint = (view: ListView): Block => {
  const r = listRef(view.list);
  return hint(`All ${view.items.length} done. Use it again with: list reset ${r} · or finish with: list archive ${r}`);
};

// ---- new, add, states, edit, order ----

async function newList(k: Store, p: Parsed): Promise<Block[]> {
  const given = split(p, ['desc', 'item', 'name', 'kind']);
  const name = given.fields.name?.[0] ?? given.words.map((w) => w.text).join(' ');
  const kind = p.flags.has('tracked') ? 'tracked' : given.fields.kind?.[0] ? kindOf(given.fields.kind[0]) : 'plain';
  const view = await createList(k, {
    name,
    target: await targetOf(k, p),
    kind,
    description: given.fields.desc?.[0] ?? null,
    tags: p.tags,
    pinned: p.flags.has('pin'),
    items: given.fields.item ?? [],
  });
  const ref = listRef(view.list);
  return [
    ok([s(ref, 'default', { bold: true, ref }), s(` ${view.list.name}`), s(` · ${kind}`, 'muted'), s(' · in ', 'muted'), projectSpan(view.project)]),
    hint(view.items.length ? `Open it with: list show ${ref}` : `Add items with: list add ${ref} item:milk item:eggs`),
    ...(view.project.project.isDefault ? [hint(`Under ${view.project.path}. Put it in a project with: list move ${ref} +client/project`)] : []),
    data(listData(view)),
  ];
}

async function add(k: Store, p: Parsed): Promise<Block[]> {
  const ref = refOf(p, 'add');
  const given = split(p, ['item'], 2);
  // Each quoted text is an item; unquoted words are one item.
  const quoted = given.words.filter((w) => w.quoted).map((w) => w.text);
  const loose = given.words.filter((w) => !w.quoted).map((w) => w.text).join(' ');
  const texts = [...(given.fields.item ?? []), ...quoted, ...(loose ? [loose] : [])];
  const before = (await findList(k, ref)).items.length;
  const view = await addItems(k, ref, texts);
  const r = listRef(view.list);
  return [
    ok([s(`Added ${plural(texts.length, 'item')} to `), s(r, 'default', { bold: true, ref: r }), s(` ${view.list.name}`), s(` · ${plural(view.items.length, 'item')}`, 'muted')]),
    ...(before === 0 ? [hint(`Show it with: list show ${r}`)] : []),
    data(listData(view)),
  ];
}

async function setState(k: Store, p: Parsed, fixed: ItemState | null): Promise<Block[]> {
  const sub = fixed ? 'done' : 'state';
  const ref = refOf(p, sub);
  const rest = p.words.slice(2);
  let state = fixed;
  if (!state) {
    const last = rest.pop()?.toLowerCase();
    if (!last || !(ITEM_STATES as readonly string[]).includes(last)) throw new KeelError(`Which state? Use ${ITEM_STATES.join(', ')}.`, 'Example: list state l1 3 blocked');
    state = last as ItemState;
  }
  const before = await findList(k, ref);
  const ids = numbers(rest, sub).map((n) => itemAt(before, n).id);
  // Items already in that state are skipped, so ticking a range twice is harmless.
  const todo = ids.filter((id) => before.items.find((i) => i.id === id)!.state !== state);
  const skipped = ids.length - todo.length;
  const view = todo.length ? await changeItems(k, ref, todo, { state }) : before;
  const r = listRef(view.list);
  return [
    ok([s(`${plural(todo.length, 'item')} ${state === 'done' ? 'done' : `now ${state}`} in `), s(r, 'default', { bold: true, ref: r }), ...(view.list.kind === 'tracked' ? [s(` · ${progressOf(view.items).label}`, 'muted')] : [])]),
    ...(skipped ? [hint(`${plural(skipped, 'item')} already ${state}.`)] : []),
    ...(view.list.kind === 'plain' ? [hint(`${r} is a plain list, so states are not shown. Track it with: list set ${r} kind:tracked`)] : []),
    ...(isComplete(view) ? [completeHint(view)] : []),
    data(listData(view)),
  ];
}

async function edit(k: Store, p: Parsed): Promise<Block[]> {
  const ref = refOf(p, 'edit');
  const given = split(p, ['note'], 3);
  const n = Number(p.words[2]);
  const text = given.words.map((w) => w.text).join(' ').trim();
  const note = given.fields.note?.[0];
  if (!Number.isInteger(n) || (!text && note === undefined)) throw new KeelError('Which item, and what change?', 'Example: list edit l1 3 "oat milk" or list edit l1 3 note:"the blue one"');
  const before = await findList(k, ref);
  const view = await changeItems(k, ref, [itemAt(before, n).id], { ...(text ? { text } : {}), ...(note !== undefined ? { note } : {}) });
  const r = listRef(view.list);
  return [ok([s(`Item ${n} of `), s(r, 'default', { bold: true, ref: r }), s(` is now ${view.items[n - 1]!.text}`)]), data(listData(view))];
}

async function remove(k: Store, p: Parsed): Promise<Block[]> {
  const ref = refOf(p, 'rm');
  const before = await findList(k, ref);
  const picked = numbers(p.words.slice(2), 'rm').map((n) => itemAt(before, n));
  const view = await removeItems(k, ref, picked.map((i) => i.id));
  const r = listRef(view.list);
  return [ok([s(`Removed ${plural(picked.length, 'item')} from `), s(r, 'default', { bold: true, ref: r }), s(` · ${picked.map((i) => i.text).join(', ')}`, 'muted')]), data(listData(view))];
}

async function order(k: Store, p: Parsed): Promise<Block[]> {
  const ref = refOf(p, 'order');
  const usage = 'Example: list order l1 3 to 1 (item 3 becomes the first)';
  const [, , from, to, place] = p.words;
  const target = place !== undefined ? place : to;
  if (!from || !target || (place !== undefined && to?.toLowerCase() !== 'to')) throw new KeelError('Move which item, to where?', usage);
  const before = await findList(k, ref);
  const item = itemAt(before, Number(from));
  const spot = Number(target);
  if (!Number.isInteger(spot) || spot < 1 || spot > before.items.length) throw new KeelError(`Place it between 1 and ${before.items.length}.`, usage);
  // Place `spot` is where it ends up: after the one now at spot-1 among the others.
  const others = before.items.filter((i) => i.id !== item.id);
  const view = await moveItem(k, ref, item.id, spot === 1 ? null : others[spot - 2]!.id);
  const r = listRef(view.list);
  return [ok([s(`Moved "${item.text}" to place ${spot} in `), s(r, 'default', { bold: true, ref: r }), ...(before.list.viewSort !== 'manual' ? [s(' · back to manual order', 'muted')] : [])]), data(listData(view))];
}

// ---- the list itself ----

async function set(k: Store, p: Parsed): Promise<Block[]> {
  const ref = refOf(p, 'set');
  const given = split(p, ['name', 'desc', 'kind', 'sort', 'tags'], 2);
  const fields: ListFields = {};
  if (given.fields.name) fields.name = given.fields.name[0]!;
  if (given.fields.desc) fields.description = given.fields.desc[0]!;
  if (given.fields.kind) fields.kind = kindOf(given.fields.kind[0]!);
  if (given.fields.sort) fields.viewSort = sortOf(given.fields.sort[0]!);
  const tags = [...p.tags, ...(given.fields.tags?.[0]?.split(/[\s,]+/) ?? [])];
  if (p.tags.length || given.fields.tags) fields.tags = tags;
  if (!Object.keys(fields).length) throw new KeelError('Change what?', 'Example: list set l1 name:"D-mart" desc:"Weekly shop" kind:tracked sort:state #groceries');
  const view = await updateList(k, ref, fields);
  const r = listRef(view.list);
  return [ok([s(r, 'default', { bold: true, ref: r }), s(` updated · ${Object.keys(fields).join(', ')}`)]), data(listData(view))];
}

async function* reset(k: Store, p: Parsed): Flow {
  const ref = refOf(p, 'reset');
  const view = await findList(k, ref);
  const r = listRef(view.list);
  const touched = view.items.filter((i) => i.state !== 'open').length;
  if (view.list.kind === 'tracked' && touched && !p.flags.has('yes')) {
    const answer = yield {
      blocks: [warn(`This sets ${plural(touched, 'item')} of ${r} ${view.list.name} back to open.`)],
      question: { prompt: 'Reset it?', hint: 'y to reset · anything else cancels' },
    };
    if (!/^y(es)?$/i.test(answer.trim())) return [warn('Nothing reset.'), data({ reset: false })];
  }
  const done = await resetList(k, ref);
  if (!done.reset) return [hint(`${r} has nothing to reset: every item is already open.`), data({ reset: false, ...listData(done.view) })];
  return [
    ok([s(r, 'default', { bold: true, ref: r }), s(` ${view.list.name} is ready again · ${plural(done.reset, 'item')} back to open`)]),
    data({ reset: true, ...listData(done.view) }),
  ];
}

async function archive(k: Store, p: Parsed, on: boolean): Promise<Block[]> {
  const ref = refOf(p, on ? 'archive' : 'unarchive');
  const view = await updateList(k, ref, { status: on ? 'archived' : 'active' });
  const r = listRef(view.list);
  return [ok([s(r, 'default', { bold: true, ref: r }), s(` ${view.list.name} ${on ? 'archived' : 'is active again'}`)]), ...(on ? [hint(`Bring it back with: list unarchive ${r}`)] : []), data(listData(view))];
}

async function pin(k: Store, p: Parsed, on: boolean): Promise<Block[]> {
  const ref = refOf(p, on ? 'pin' : 'unpin');
  const view = await updateList(k, ref, { pinned: on });
  const r = listRef(view.list);
  return [ok([s(r, 'default', { bold: true, ref: r }), s(` ${view.list.name} ${on ? 'pinned' : 'unpinned'}`)]), data(listData(view))];
}

async function move(k: Store, p: Parsed): Promise<Block[]> {
  const ref = refOf(p, 'move');
  if (!p.projects[0]) throw new KeelError('Move it where?', 'Example: list move l1 +acme/website (or +acme, or +personal)');
  const view = await moveList(k, ref, await targetOf(k, p));
  const r = listRef(view.list);
  return [ok([s(r, 'default', { bold: true, ref: r }), s(` ${view.list.name} is now in `), projectSpan(view.project)]), data(listData(view))];
}

async function readCoverFile(path: string): Promise<Cover> {
  const file = resolve(path.replace(/^~(?=$|\/)/, homedir()));
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new KeelError(`Can't read ${file}.`);
  }
  return coverFromBytes(bytes);
}

async function cover(k: Store, p: Parsed): Promise<Block[]> {
  const ref = refOf(p, 'cover');
  const given = split(p, ['dark'], 2);
  if (p.flags.has('clear')) {
    const { view } = await setCover(k, ref, null);
    return [ok([s(listRef(view.list), 'default', { bold: true }), s(' cover cleared. It shows the default again.')]), data(listData(view))];
  }
  const path = given.words[0]?.text;
  if (!path) throw new KeelError('Which file?', 'Example: list cover l1 ~/covers/groceries.svg dark:~/covers/groceries-dark.svg, or list cover l1 --clear');
  const light = await readCoverFile(path);
  const dark = given.fields.dark?.[0] ? await readCoverFile(given.fields.dark[0]) : null;
  const { view, totalBytes, overNotice } = await setCover(k, ref, light, dark ? checkCover(dark.kind, dark.data) : null);
  const r = listRef(view.list);
  return [
    ok([s('Cover set on '), s(r, 'default', { bold: true, ref: r }), s(` · ${light.kind.toUpperCase()}${dark ? ', light and dark' : ''}`, 'muted')]),
    ...(overNotice ? [warn(`Covers now take ${formatBytes(totalBytes)}, past 10 MB. Time to move them to object storage (ADR 0005).`)] : []),
    data({ ...listData(view), coverBytesTotal: totalBytes }),
  ];
}

async function* del(k: Store, p: Parsed): Flow {
  const ref = refOf(p, 'delete');
  const view = await findList(k, ref);
  const r = listRef(view.list);
  const summary = `${r} ${view.list.name} with ${plural(view.items.length, 'item')}`;
  if (!p.flags.has('yes')) {
    const answer = yield {
      blocks: [warn(`This deletes ${summary}.`), hint('Deleted items disappear from Keel. Your daily backups and exports from before today still have them. To keep it but hide it: list archive ' + r)],
      question: { prompt: `Type ${r} to confirm`, hint: 'anything else cancels' },
    };
    if (answer.trim().toLowerCase() !== r) return [warn('Nothing deleted.'), data({ deleted: false })];
  }
  await deleteList(k, ref);
  return [ok(`Deleted ${summary}.`), data({ deleted: true, ref: r, items: view.items.length })];
}
