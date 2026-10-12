import { and, eq, gte, lt } from 'drizzle-orm';
import { blank, data, heading, hint, line, s, table, type Bar, type Block, type Span } from '../blocks';
import { addDays, dayStartIso, formatDay, formatRange, isoWeek, weekStart, ymd } from '../dates';
import * as t from '../db/schema';
import { KeelError } from '../errors';
import type { Store } from '../store';
import { formatDuration } from './projects';
import { matchesScope, type Command } from './shared';

export type PeriodKind = 'day' | 'week' | 'last';

interface Period {
  from: string;
  to: string;
  label: string;
}

function periodFor(kind: PeriodKind, today: string): Period {
  if (kind === 'day') return { from: today, to: today, label: formatDay(today) };
  const from = kind === 'week' ? weekStart(today) : addDays(weekStart(today), -7);
  const to = addDays(from, 6);
  return { from, to, label: `Week ${isoWeek(from)} · ${formatRange(from, to)}` };
}

interface Stats {
  kept: number;
  renegotiated: number;
  slipped: Array<{ ref: string; title: string }>;
  received: number;
  waiting: number;
  rate: number | null;
  minutesByClient: Map<string, { minutes: number; hue: Bar['tone'] }>;
  switches: number;
  notes: number;
}

const localDay = (iso: string) => ymd(new Date(iso));

async function statsFor(k: Store, period: Period, scope?: string): Promise<Stats> {
  const today = k.today();
  const startIso = dayStartIso(period.from);
  const endIso = dayStartIso(addDays(period.to, 1));
  const inPeriod = (iso: string | null) => Boolean(iso) && localDay(iso!) >= period.from && localDay(iso!) <= period.to;

  const all = (await k.commitmentViews()).filter((v) => matchesScope(v, scope));
  const ids = new Set(all.map((v) => v.c.id));
  const doneOwe = all.filter((v) => v.c.direction === 'owe' && v.c.status === 'done' && inPeriod(v.c.closedAt));
  const kept = doneOwe.filter((v) => localDay(v.c.closedAt!) <= v.c.dueOn);
  const doneLate = doneOwe.filter((v) => localDay(v.c.closedAt!) > v.c.dueOn);
  const lastDay = period.to < today ? period.to : addDays(today, -1);
  const lateOpen = all.filter((v) => v.c.direction === 'owe' && v.c.status === 'open' && v.c.dueOn >= period.from && v.c.dueOn <= lastDay);

  const renegotiations = await k.db
    .select()
    .from(t.events)
    .where(and(eq(t.events.kind, 'renegotiated'), gte(t.events.createdAt, startIso), lt(t.events.createdAt, endIso)));
  const renegotiated = renegotiations.filter((e) => ids.has(e.entityId)).length;

  const slipped = [...lateOpen, ...doneLate].map((v) => ({ ref: `c${v.c.refNo}`, title: v.c.title }));
  const denominator = kept.length + renegotiated + slipped.length;

  // Time per client, from the switch log, clipped to the period and to now.
  const projects = new Map((await k.listProjects()).map((pv) => [pv.project.id, pv]));
  const inScope = (projectId: string) => {
    const pv = projects.get(projectId);
    return Boolean(pv) && (!scope || (scope.includes('/') ? pv!.path === scope : pv!.client.slug === scope));
  };
  const logs = await k.db.select().from(t.contextLog).where(lt(t.contextLog.startedAt, endIso));
  const nowMs = k.now().getTime();
  const minutesByClient: Stats['minutesByClient'] = new Map();
  let switches = 0;
  for (const log of logs) {
    const pv = projects.get(log.projectId);
    if (!pv || !inScope(log.projectId)) continue;
    const start = Math.max(new Date(log.startedAt).getTime(), new Date(startIso).getTime());
    const end = Math.min(log.endedAt ? new Date(log.endedAt).getTime() : nowMs, new Date(endIso).getTime(), nowMs);
    if (log.startedAt >= startIso) switches++;
    if (end <= start) continue;
    const entry = minutesByClient.get(pv.client.slug) ?? { minutes: 0, hue: pv.hue };
    entry.minutes += (end - start) / 60_000;
    minutesByClient.set(pv.client.slug, entry);
  }

  const notes = (
    await k.db.select().from(t.resumeNotes).where(and(gte(t.resumeNotes.createdAt, startIso), lt(t.resumeNotes.createdAt, endIso)))
  ).filter((n) => inScope(n.projectId)).length;

  return {
    kept: kept.length,
    renegotiated,
    slipped,
    received: all.filter((v) => v.c.direction === 'wait' && v.c.status === 'done' && inPeriod(v.c.closedAt)).length,
    waiting: all.filter((v) => v.c.direction === 'wait' && v.c.status === 'open').length,
    rate: denominator ? Math.round(((kept.length + renegotiated) / denominator) * 100) : null,
    minutesByClient,
    switches,
    notes,
  };
}

export async function summaryBlocks(k: Store, kind: PeriodKind, scope?: string): Promise<Block[]> {
  const period = periodFor(kind, k.today());
  const st = await statsFor(k, period, scope);
  const previous = kind === 'week' ? await statsFor(k, periodFor('last', k.today()), scope) : null;

  const num = (n: number, tone: Span['tone']) => s(String(n).padStart(3), n ? tone : 'muted');
  const rows: Span[][] = [
    [s('promises kept'), num(st.kept, 'done'), s('on time', 'muted')],
    [s('renegotiated'), num(st.renegotiated, 'today'), s('agreed a new date in time', 'muted')],
    [s('slipped'), num(st.slipped.length, 'late'), s(st.slipped.slice(0, 3).map((x) => `${x.ref} ${x.title}`).join(', '), 'muted')],
    [s('received'), num(st.received, 'wait'), s('things you were waiting on', 'muted')],
    [s('still waiting on'), num(st.waiting, 'wait')],
    [
      s('kept rate'),
      s(st.rate === null ? '  -' : `${st.rate}%`.padStart(4), 'default', { bold: true }),
      s(previous?.rate != null ? `last week ${previous.rate}%` : '', 'muted'),
    ],
  ];

  const out: Block[] = [line([s(period.label, 'default', { bold: true }), ...(scope ? [s(` · +${scope}`, 'muted')] : [])]), blank(), table(rows)];

  const clients = [...st.minutesByClient.entries()].filter(([, v]) => v.minutes >= 1).sort((a, b) => b[1].minutes - a[1].minutes);
  if (clients.length) {
    out.push(
      blank(),
      heading('TIME PER CLIENT', 'muted'),
      {
        kind: 'bars',
        items: clients.map(([slug, v]) => ({ label: slug, value: v.minutes, display: formatDuration(Math.round(v.minutes)), tone: v.hue })),
      },
      line([s(`${st.switches} switch${st.switches === 1 ? '' : 'es'} · ${st.notes} resume note${st.notes === 1 ? '' : 's'} written`, 'muted')], 2),
    );
  } else {
    out.push(blank(), hint('No time logged yet. Time comes from switch, so it fills in as you move between projects.'));
  }
  out.push(
    data({
      period: { kind, from: period.from, to: period.to },
      scope: scope ?? null,
      kept: st.kept,
      renegotiated: st.renegotiated,
      slipped: st.slipped,
      received: st.received,
      waiting: st.waiting,
      keptRate: st.rate,
      lastWeekKeptRate: previous?.rate ?? null,
      minutesByClient: Object.fromEntries([...st.minutesByClient].map(([slug, v]) => [slug, Math.round(v.minutes)])),
      switches: st.switches,
      resumeNotes: st.notes,
    }),
  );
  return out;
}

export const summary: Command = {
  name: 'summary',
  usage: 'summary [day|week|last] [+client]',
  summary: 'Kept, renegotiated, slipped, waiting, time per client',
  async run(k, p) {
    const kind = (p.words[0] ?? 'week').toLowerCase();
    if (kind !== 'day' && kind !== 'week' && kind !== 'last') throw new KeelError(`Unknown period "${kind}".`, 'Use: summary day, summary week or summary last');
    return summaryBlocks(k, kind, p.projects[0]);
  },
};
