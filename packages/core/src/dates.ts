import * as chrono from 'chrono-node';
import type { Tone } from './blocks';

// Due dates are plain calendar days (YYYY-MM-DD) in the user's local timezone.

const pad = (n: number) => String(n).padStart(2, '0');

export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function fromYmd(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function addDays(day: string, n: number): string {
  const d = fromYmd(day);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86_400_000);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Monday of the week that contains `day` (weeks start on Monday). */
export function weekStart(day: string): string {
  const dow = fromYmd(day).getDay();
  return addDays(day, dow === 0 ? -6 : 1 - dow);
}

export function parseDue(input: string, now: Date): string | null {
  const text = input.trim().toLowerCase();
  const today = ymd(now);
  if (!text) return null;
  if (text === 'today' || text === 'tod') return today;
  if (text === 'tomorrow' || text === 'tom') return addDays(today, 1);
  if (text === 'eow') {
    const dow = now.getDay();
    return addDays(today, dow <= 5 ? 5 - dow : 6);
  }

  const rel = /^\+(\d+)([dw])$/.exec(text);
  if (rel) return addDays(today, Number(rel[1]) * (rel[2] === 'w' ? 7 : 1));

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  if (text.length >= 3) {
    const target = WEEKDAYS.findIndex((w) => w.startsWith(text));
    if (target >= 0) {
      const ahead = (target - now.getDay() + 7) % 7 || 7;
      return addDays(today, ahead);
    }
  }

  const parsed = chrono.parseDate(input, now, { forwardDate: true });
  return parsed ? ymd(parsed) : null;
}

/** "Thu 15 Oct" */
export function formatDay(day: string): string {
  return fromYmd(day).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Short, relative label for a due date, with the tone that goes with it. */
export function describeDue(due: string, today: string): { text: string; tone: Tone } {
  const diff = dayDiff(today, due);
  if (diff < 0) return { text: `${-diff}d late`, tone: 'late' };
  if (diff === 0) return { text: 'today', tone: 'today' };
  if (diff === 1) return { text: 'tomorrow', tone: 'default' };
  if (diff < 7) return { text: formatDay(due).split(' ')[0] ?? due, tone: 'default' };
  return { text: formatDay(due), tone: 'muted' };
}

/** "Thu 15 Oct 14:05" in local time, for history lines. */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  return `${formatDay(ymd(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO 8601 week number (weeks start on Monday). */
export function isoWeek(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  const dow = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dow + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

/** "12 to 18 Oct", or "28 Sep to 4 Oct" across months. */
export function formatRange(from: string, to: string): string {
  const [, fromDay, fromMonth] = formatDay(from).split(' ');
  const [, toDay, toMonth] = formatDay(to).split(' ');
  return fromMonth === toMonth ? `${fromDay} to ${toDay} ${toMonth}` : `${fromDay} ${fromMonth} to ${toDay} ${toMonth}`;
}

/** Local midnight of a calendar day, as a UTC ISO timestamp. */
export function dayStartIso(day: string): string {
  return fromYmd(day).toISOString();
}
