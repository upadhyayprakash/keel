// ADR 0005: fractional position keys for list items. A key is a short string that
// sorts by plain text order (SQLite's default), and a new key can always be made
// between two others. So a drag writes one row, and two devices dragging different
// items merge without renumbering anything (integers would collide).
//
// The digits are in ASCII order ('0'-'9' < 'A'-'Z' < 'a'-'z'), so text order and key
// order agree. A key never ends in the lowest digit, which is what keeps a gap open
// below every key.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const LOW = DIGITS[0]!;

/** Past this length a list is renumbered, so keys stay short. */
export const MAX_KEY_LENGTH = 24;

const digit = (ch: string | undefined): number => {
  const n = ch === undefined ? 0 : DIGITS.indexOf(ch);
  if (n < 0) throw new Error(`Not a position key: "${ch}"`);
  return n;
};

/** A key strictly between `a` and `b` (a < b), where `a` is '' for "no lower bound" and `b` is null for "no upper bound". */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Skip the shared start, treating a missing digit of `a` as the lowest.
    let n = 0;
    while ((a[n] ?? LOW) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const lo = digit(a[0]);
  const hi = b === null ? BASE : digit(b[0]);
  if (hi - lo > 1) return DIGITS[Math.round((lo + hi) / 2)]!;
  // Neighbouring first digits: use the upper one's own start when it has more after it...
  if (b !== null && b.length > 1) return b.slice(0, 1);
  // ...otherwise keep the lower digit and go one place deeper.
  return DIGITS[lo]! + midpoint(a.slice(1), null);
}

/** Whether `key` is a well-formed position key. */
export function isKey(key: string): boolean {
  return key.length > 0 && !key.endsWith(LOW) && [...key].every((ch) => DIGITS.includes(ch));
}

/** A key between `a` and `b`; null means the start or the end of the list. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && !isKey(a)) throw new Error(`Not a position key: "${a}"`);
  if (b !== null && !isKey(b)) throw new Error(`Not a position key: "${b}"`);
  if (a !== null && b !== null && a >= b) throw new Error(`Keys are out of order: "${a}" is not before "${b}"`);
  return midpoint(a ?? '', b);
}

/** `n` keys in order between `a` and `b`, spread so they stay short. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  const mid = Math.floor(n / 2);
  const middle = keyBetween(a, b);
  return [...keysBetween(a, middle, mid), middle, ...keysBetween(middle, b, n - mid - 1)];
}
