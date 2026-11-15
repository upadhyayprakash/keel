import { describe, expect, it } from 'vitest';
import { isKey, keyBetween, keysBetween, MAX_KEY_LENGTH } from '../src/fractional';

const sorted = (keys: string[]) => [...keys].sort();

describe('position keys', () => {
  it('makes a first key, and keys before and after it', () => {
    const first = keyBetween(null, null);
    expect(isKey(first)).toBe(true);
    expect(keyBetween(null, first) < first).toBe(true);
    expect(keyBetween(first, null) > first).toBe(true);
  });

  it('puts a key between two neighbours, even adjacent ones', () => {
    expect(keyBetween('a', 'c') > 'a' && keyBetween('a', 'c') < 'c').toBe(true);
    const mid = keyBetween('a', 'b');
    expect(mid > 'a' && mid < 'b').toBe(true);
    const deeper = keyBetween('a', mid);
    expect(deeper > 'a' && deeper < mid).toBe(true);
  });

  it('never ends a key in the lowest digit, so a gap stays open below every key', () => {
    let a: string | null = null;
    for (let i = 0; i < 200; i++) {
      const k = keyBetween(a, null);
      expect(isKey(k)).toBe(true);
      a = k;
    }
    let b: string | null = null;
    for (let i = 0; i < 200; i++) {
      const k = keyBetween(null, b);
      expect(isKey(k)).toBe(true);
      b = k;
    }
  });

  it('refuses keys that are out of order, equal, or not keys', () => {
    expect(() => keyBetween('b', 'a')).toThrow(/out of order/);
    expect(() => keyBetween('a', 'a')).toThrow(/out of order/);
    expect(() => keyBetween('a0', null)).toThrow(/Not a position key/);
    expect(() => keyBetween('a-', null)).toThrow(/Not a position key/);
    expect(() => keyBetween('', null)).toThrow(/Not a position key/);
  });

  it('keeps the order after many random inserts', () => {
    // A deterministic generator, so a failure can be repeated.
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % n;
    };
    const keys: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const at = rand(keys.length + 1);
      const k = keyBetween(keys[at - 1] ?? null, keys[at] ?? null);
      keys.splice(at, 0, k);
    }
    expect(keys).toEqual(sorted(keys));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('makes n keys in order that stay short', () => {
    for (const n of [1, 2, 7, 50, 300]) {
      const keys = keysBetween(null, null, n);
      expect(keys).toHaveLength(n);
      expect(keys).toEqual(sorted(keys));
      expect(new Set(keys).size).toBe(n);
      expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(5);
    }
    const inside = keysBetween('a', 'b', 20);
    expect(inside.every((k) => k > 'a' && k < 'b')).toBe(true);
    expect(inside).toEqual(sorted(inside));
  });

  it('grows slowly when you keep adding at the end', () => {
    let last: string | null = null;
    for (let i = 0; i < 100; i++) last = keyBetween(last, null);
    // A list renumbers past MAX_KEY_LENGTH, which 100 appends are far from.
    expect(last!.length).toBeLessThan(MAX_KEY_LENGTH);
  });

  it('two devices dragging different items agree on one order', () => {
    // Both start from the same order and each makes one key; the keys differ because
    // they sit between different neighbours, and the merged order is just the sort.
    const base = keysBetween(null, null, 6);
    const laptop = keyBetween(base[0]!, base[1]!); // item moved between 1st and 2nd
    const phone = keyBetween(base[4]!, base[5]!); // another between 5th and 6th
    const merged = sorted([...base, laptop, phone]);
    expect(merged.indexOf(laptop)).toBe(1);
    expect(merged.indexOf(phone)).toBe(6);
  });
});
