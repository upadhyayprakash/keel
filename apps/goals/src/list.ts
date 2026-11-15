// A list as the API sends it: the same fields as `keel list show --json` (ADR 0005).
// Items are named by `id` here; `number` is what the CLI uses.

import { COVER_PLACEHOLDER } from '@keel/core/ui';

export type ItemState = 'open' | 'doing' | 'blocked' | 'done';
export type ViewSort = 'manual' | 'state' | 'created' | 'alpha';
export type ListKind = 'plain' | 'tracked';

export interface ListItem {
  number: number;
  id: string;
  text: string;
  note: string | null;
  state: ItemState;
  doneAt: string | null;
}

export interface Progress {
  done: number;
  total: number;
  label: string;
}

export interface CoverInfo {
  kind: 'svg' | 'png';
  dark: boolean;
}

/** One list in the gallery: GET /api/lists. No items, just how many. */
export interface ListSummary {
  ref: string;
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  kind: ListKind;
  pinned: boolean;
  status: 'active' | 'archived';
  project: string;
  projectRef: string;
  progress: Progress | null;
  itemCount: number;
  cover: CoverInfo | null;
  updatedAt: string;
}

/** One list with its items: GET /api/lists/<ref>. */
export interface List {
  ref: string;
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  kind: ListKind;
  viewSort: ViewSort;
  pinned: boolean;
  status: 'active' | 'archived';
  project: string;
  projectRef: string;
  progress: Progress | null;
  cover: (CoverInfo & { bytes: number }) | null;
  resetCount: number;
  lastResetAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** In stored order. */
  items: ListItem[];
  /** The item numbers in the order the list is set to show. */
  shownOrder: number[];
}

/** Where a new list can go: GET /api/lists/targets. */
export interface Target {
  value: string;
  label: string;
}

export const STATES: ItemState[] = ['open', 'doing', 'blocked', 'done'];
export const STATE_LABEL: Record<ItemState, string> = { open: 'Open', doing: 'Doing', blocked: 'Blocked', done: 'Done' };
export const SORTS: Array<{ value: ViewSort; label: string }> = [
  { value: 'manual', label: 'Manual' },
  { value: 'state', label: 'By state' },
  { value: 'created', label: 'Newest last' },
  { value: 'alpha', label: 'A to Z' },
];

/** The items in the order the list is set to show. */
export function shownItems(list: Pick<List, 'items' | 'shownOrder'>): ListItem[] {
  return list.shownOrder.map((n) => list.items[n - 1]).filter((i): i is ListItem => Boolean(i));
}

/** A tracked list with items, every one done: time to offer Reset or Archive (never automatic). */
export const isComplete = (list: Pick<List, 'kind' | 'status' | 'items'>) =>
  list.kind === 'tracked' && list.status === 'active' && list.items.length > 0 && list.items.every((i) => i.state === 'done');

/** Words that match a list in the gallery search: its name, description and tags. */
export function matches(list: Pick<ListSummary, 'name' | 'description' | 'tags'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [list.name, list.description ?? '', ...list.tags].some((text) => text.toLowerCase().includes(q));
}

/** `groceries, weekly #home` as ['groceries', 'weekly', 'home']. The server checks them again. */
export const parseTags = (text: string): string[] => text.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean);

/** One item per non-empty line, so pasting a list adds all of it. */
export const splitLines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean);

// ---- reordering ----

/** The id of the item to place `id` after so it ends at `toIndex` (0 is first), or null for first. */
export function afterIdAt(ids: string[], id: string, toIndex: number): string | null {
  const others = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(toIndex, others.length));
  return at === 0 ? null : others[at - 1]!;
}

/** `ids` with `id` moved so it ends at `toIndex`. */
export function moveInOrder<T extends { id: string }>(items: T[], id: string, toIndex: number): T[] {
  const item = items.find((i) => i.id === id);
  if (!item) return items;
  const others = items.filter((i) => i.id !== id);
  const at = Math.max(0, Math.min(toIndex, others.length));
  return [...others.slice(0, at), item, ...others.slice(at)];
}

/** Where a dragged row would land: how many of the other rows lie above the pointer. `mids` are the rows' middles, `skip` the dragged one. */
export function insertIndex(mids: number[], y: number, skip: number): number {
  return mids.filter((mid, i) => i !== skip && mid < y).length;
}

// ---- covers ----

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export const PLACEHOLDER = { light: svgUrl(COVER_PLACEHOLDER.light), dark: svgUrl(COVER_PLACEHOLDER.dark) };

/** The cover's address for a theme. `version` (the list's `updatedAt`) makes a new cover load again. */
export const coverUrl = (ref: string, theme: 'light' | 'dark', version: string) => `/api/lists/${encodeURIComponent(ref)}/cover?theme=${theme}&v=${encodeURIComponent(version)}`;

/** Both themes' addresses for a list: its own cover, or the built-in placeholder. */
export function coverSources(list: { ref: string; cover: CoverInfo | null; updatedAt: string }): { light: string; dark: string } {
  if (!list.cover) return PLACEHOLDER;
  const light = coverUrl(list.ref, 'light', list.updatedAt);
  return { light, dark: list.cover.dark ? coverUrl(list.ref, 'dark', list.updatedAt) : light };
}

/** A picked file as the API takes it: SVG text, or a PNG as base64. Null when it is neither. */
export async function readCoverFile(file: Pick<File, 'type' | 'name' | 'arrayBuffer'>): Promise<{ kind: 'svg' | 'png'; data: string } | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isPng) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { kind: 'png', data: btoa(binary) };
  }
  const text = new TextDecoder().decode(bytes);
  return /^\s*(<\?xml|<!--|<!DOCTYPE|<svg)/i.test(text) ? { kind: 'svg', data: text } : null;
}
