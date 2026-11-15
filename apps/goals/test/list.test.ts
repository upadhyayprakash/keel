import { describe, expect, it } from 'vitest';
import { afterIdAt, coverSources, coverUrl, insertIndex, isComplete, matches, moveInOrder, parseTags, PLACEHOLDER, readCoverFile, shownItems, splitLines, type ListItem } from '../src/list';

const item = (n: number, text: string, state: ListItem['state'] = 'open'): ListItem => ({ number: n, id: `i${n}`, text, note: null, state, doneAt: null });

describe('shownItems', () => {
  it('follows the order the server sends, not the stored one', () => {
    const items = [item(1, 'cherry'), item(2, 'apple'), item(3, 'banana')];
    expect(shownItems({ items, shownOrder: [2, 3, 1] }).map((i) => i.text)).toEqual(['apple', 'banana', 'cherry']);
    expect(shownItems({ items, shownOrder: [1, 2, 3] }).map((i) => i.text)).toEqual(['cherry', 'apple', 'banana']);
  });
});

describe('isComplete', () => {
  it('offers reset or archive for a tracked list with every item done', () => {
    const done = [item(1, 'a', 'done'), item(2, 'b', 'done')];
    expect(isComplete({ kind: 'tracked', status: 'active', items: done })).toBe(true);
    expect(isComplete({ kind: 'tracked', status: 'active', items: [...done, item(3, 'c')] })).toBe(false);
    expect(isComplete({ kind: 'plain', status: 'active', items: done })).toBe(false);
    expect(isComplete({ kind: 'tracked', status: 'archived', items: done })).toBe(false);
    expect(isComplete({ kind: 'tracked', status: 'active', items: [] })).toBe(false);
  });
});

describe('search and typing', () => {
  it('matches name, description and tags, ignoring case', () => {
    const l = { name: 'D-mart', description: 'Weekly shop', tags: ['groceries', 'home'] };
    for (const q of ['', 'd-m', 'WEEKLY', 'grocer', ' home ']) expect(matches(l, q), q).toBe(true);
    expect(matches(l, 'trip')).toBe(false);
  });

  it('reads tags and one item per line', () => {
    expect(parseTags('#groceries, weekly  home')).toEqual(['groceries', 'weekly', 'home']);
    expect(parseTags('')).toEqual([]);
    expect(splitLines('milk\n\n- eggs\r\n2) bread\n  * tea  ')).toEqual(['milk', 'eggs', 'bread', 'tea']);
    expect(splitLines('10 kg rice')).toEqual(['10 kg rice']);
  });
});

describe('reordering', () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const ids = items.map((i) => i.id);

  it('moves an item to a place', () => {
    expect(moveInOrder(items, 'd', 0).map((i) => i.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveInOrder(items, 'a', 2).map((i) => i.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveInOrder(items, 'a', 99).map((i) => i.id)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveInOrder(items, 'b', -3).map((i) => i.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveInOrder(items, 'nope', 1)).toBe(items);
  });

  it('names the item to place it after, the way the server takes it', () => {
    expect(afterIdAt(ids, 'd', 0)).toBeNull();
    expect(afterIdAt(ids, 'd', 1)).toBe('a');
    expect(afterIdAt(ids, 'a', 2)).toBe('c'); // b, c, then a
    expect(afterIdAt(ids, 'a', 99)).toBe('d');
    // It agrees with moveInOrder for every place.
    for (const id of ids) {
      for (let to = 0; to < ids.length; to++) {
        const after = afterIdAt(ids, id, to);
        const result = moveInOrder(items, id, to).map((i) => i.id);
        expect(after === null ? 0 : result.indexOf(after) + 1, `${id} to ${to}`).toBe(result.indexOf(id));
      }
    }
  });

  it('finds where a dragged row lands from the pointer', () => {
    const mids = [10, 30, 50, 70]; // four rows
    expect(insertIndex(mids, 0, 2)).toBe(0);
    expect(insertIndex(mids, 20, 2)).toBe(1);
    expect(insertIndex(mids, 60, 0)).toBe(2); // rows b and c are above; the dragged one does not count
    expect(insertIndex(mids, 999, 1)).toBe(3);
  });
});

describe('covers', () => {
  it('uses the built-in placeholder when no cover is set', () => {
    const src = coverSources({ ref: 'l1', cover: null, updatedAt: 'x' });
    expect(src).toBe(PLACEHOLDER);
    expect(src.light).toMatch(/^data:image\/svg\+xml/);
    expect(decodeURIComponent(src.light)).toContain('<svg');
    expect(src.light).not.toBe(src.dark);
  });

  it("points at the list's own cover, with the dark one when it has it", () => {
    const own = coverSources({ ref: 'l3', cover: { kind: 'svg', dark: true }, updatedAt: '2026-10-12T03:30:00.000Z' });
    expect(own.light).toBe('/api/lists/l3/cover?theme=light&v=2026-10-12T03%3A30%3A00.000Z');
    expect(own.dark).toBe(coverUrl('l3', 'dark', '2026-10-12T03:30:00.000Z'));
    const single = coverSources({ ref: 'l3', cover: { kind: 'png', dark: false }, updatedAt: 'v' });
    expect(single.dark).toBe(single.light);
  });

  it('reads a picked SVG or PNG, and refuses other files', async () => {
    const file = (bytes: number[] | string) => ({ type: '', name: 'x', arrayBuffer: async () => (typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes)).buffer as ArrayBuffer });
    expect(await readCoverFile(file('<?xml version="1.0"?><svg/>'))).toEqual({ kind: 'svg', data: '<?xml version="1.0"?><svg/>' });
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
    expect(await readCoverFile(file(png))).toEqual({ kind: 'png', data: btoa(String.fromCharCode(...png)) });
    expect(await readCoverFile(file('hello'))).toBeNull();
    expect(await readCoverFile(file('GIF89a....'))).toBeNull();
  });
});
