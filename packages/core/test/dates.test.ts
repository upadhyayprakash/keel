import { describe, expect, it } from 'vitest';
import { describeDue, formatDay, parseDue, weekStart } from '../src/dates';

// Monday 12 October 2026, 09:00 local time.
const now = new Date(2026, 9, 12, 9, 0);

describe('parseDue', () => {
  it.each([
    ['today', '2026-10-12'],
    ['tomorrow', '2026-10-13'],
    ['thu', '2026-10-15'],
    ['thursday', '2026-10-15'],
    ['mon', '2026-10-19'],
    ['eow', '2026-10-16'],
    ['+3d', '2026-10-15'],
    ['+1w', '2026-10-19'],
    ['2026-11-02', '2026-11-02'],
  ])('%s -> %s', (input, expected) => {
    expect(parseDue(input, now)).toBe(expected);
  });

  it('falls back to natural language', () => {
    expect(parseDue('next friday', now)).toBe('2026-10-23');
  });

  it('returns null for nonsense', () => {
    expect(parseDue('banana', now)).toBeNull();
  });
});

describe('describeDue', () => {
  it('labels late, today, soon and later', () => {
    expect(describeDue('2026-10-10', '2026-10-12')).toEqual({ text: '2d late', tone: 'late' });
    expect(describeDue('2026-10-12', '2026-10-12')).toEqual({ text: 'today', tone: 'today' });
    expect(describeDue('2026-10-13', '2026-10-12').text).toBe('tomorrow');
    expect(describeDue('2026-10-15', '2026-10-12').text).toBe('Thu');
    expect(describeDue('2026-10-30', '2026-10-12').text).toBe('Fri 30 Oct');
  });
});

describe('formatDay and weekStart', () => {
  it('formats short days and finds Monday', () => {
    expect(formatDay('2026-10-15')).toBe('Thu 15 Oct');
    expect(weekStart('2026-10-15')).toBe('2026-10-12');
    expect(weekStart('2026-10-18')).toBe('2026-10-12');
  });
});
