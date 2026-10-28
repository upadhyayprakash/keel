import { describe, expect, it } from 'vitest';
import { cueLabel, dayDiff, daysLeft, formatDay, fraction } from '../src/format';

// Monday 12 October 2026.
const TODAY = '2026-10-12';

describe('dates', () => {
  it('counts days across months and years', () => {
    expect(dayDiff(TODAY, '2026-11-08')).toBe(27);
    expect(dayDiff(TODAY, '2026-10-10')).toBe(-2);
    expect(dayDiff('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('formats days like the CLI', () => {
    expect(formatDay('2026-11-08', TODAY)).toBe('Sun 8 Nov');
    expect(formatDay('2027-01-02', TODAY)).toBe('Sat 2 Jan 2027');
  });

  it('says how long is left', () => {
    expect(daysLeft('2026-11-04', TODAY)).toBe('23 days left');
    expect(daysLeft('2026-10-13', TODAY)).toBe('1 day left');
    expect(daysLeft(TODAY, TODAY)).toBe('due today');
    expect(daysLeft('2026-10-11', TODAY)).toBe('1 day late');
    expect(daysLeft('2026-10-10', TODAY)).toBe('2 days late');
  });
});

describe('cueLabel', () => {
  it('reads like the cue chips on the screens', () => {
    expect(cueLabel('2026-10-12T07:00', 'park', TODAY)).toBe('Today 7:00 · park');
    expect(cueLabel('2026-10-13T18:30', null, TODAY)).toBe('Tomorrow 18:30');
    expect(cueLabel('2026-10-17T07:00', 'park', TODAY)).toBe('Sat 7:00 · park');
    expect(cueLabel('2026-10-24T10:00', null, TODAY)).toBe('Sat 24 Oct 10:00');
    expect(cueLabel('2026-10-10T07:00', null, TODAY)).toBe('Sat 10 Oct 7:00');
  });

  it('shows the place alone, or nothing', () => {
    expect(cueLabel(null, 'after work', TODAY)).toBe('after work');
    expect(cueLabel(null, null, TODAY)).toBeNull();
  });
});

describe('fraction', () => {
  it('stays between 0 and 1', () => {
    expect(fraction(4, 12)).toBeCloseTo(1 / 3);
    expect(fraction(0, 0)).toBe(0);
    expect(fraction(5, 3)).toBe(1);
  });
});
