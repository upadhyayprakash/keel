// Dates in the Goals app are the server's plain strings: days as `YYYY-MM-DD`,
// cues as local `YYYY-MM-DDTHH:MM`. `today` always comes from the server
// (GET /api/goals), so the phone and the CLI agree on what "today" is.

function fromYmd(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function dayDiff(from: string, to: string): number {
  return Math.round((fromYmd(to).getTime() - fromYmd(from).getTime()) / 86_400_000);
}

/** "Sat 8 Nov", or "Sat 8 Nov 2027" outside the current year. Same as the CLI. */
export function formatDay(day: string, today: string): string {
  const short = fromYmd(day).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return day.slice(0, 4) === today.slice(0, 4) ? short : `${short} ${day.slice(0, 4)}`;
}

/** "23 days left", "1 day left", "due today", "2 days late". */
export function daysLeft(due: string, today: string): string {
  const diff = dayDiff(today, due);
  if (diff === 0) return 'due today';
  if (diff < 0) return `${-diff} day${diff === -1 ? '' : 's'} late`;
  return `${diff} day${diff === 1 ? '' : 's'} left`;
}

/** "7:00" from "07:00". */
const clock = (hhmm: string) => hhmm.replace(/^0(\d)/, '$1');

/**
 * A cue as it reads on a chip: "Today 7:00 · park", "Tomorrow 18:30", "Sat 7:00 · park"
 * within the coming week, then "Sat 24 Oct 7:00". Null when the step has no cue.
 */
export function cueLabel(cueAt: string | null, place: string | null, today: string): string | null {
  const parts: string[] = [];
  if (cueAt) {
    const day = cueAt.slice(0, 10);
    const diff = dayDiff(today, day);
    const when = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff > 1 && diff < 7 ? formatDay(day, today).split(' ')[0]! : formatDay(day, today);
    parts.push(`${when} ${clock(cueAt.slice(11, 16))}`);
  }
  if (place) parts.push(place);
  return parts.length ? parts.join(' · ') : null;
}

/** Share of steps done, 0 to 1, for the progress bar. */
export const fraction = (done: number, total: number) => (total > 0 ? Math.min(1, Math.max(0, done / total)) : 0);

/**
 * When the not-live copy was saved, in this phone's own time: "at 14:05" the same day,
 * "yesterday at 21:40", then "on Tue 27 Oct at 9:15".
 */
export function seenAt(savedAt: string, now = new Date()): string {
  const at = new Date(savedAt);
  const time = clock(at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }));
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  return `on ${at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${time}`;
}
