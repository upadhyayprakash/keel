import { eq } from 'drizzle-orm';
import { blank, data, heading, hint, line, s, table, type Block, type Span, type Tone } from '../blocks';
import { addDays, dayDiff, formatDay, formatStamp, weekStart, ymd } from '../dates';
import * as t from '../db/schema';
import { KeelError } from '../errors';
import { parseRef } from '../parse';
import type { CommitmentView, Store } from '../store';
import { commitmentData, commitmentRow, inboxData, matchesScope, noteData, projectData, projectSpan, type Command } from './shared';

const STALE_DAYS = 7;

const formatLocal = (iso: string) => ymd(new Date(iso));

export const today: Command = {
  name: 'today',
  usage: 'today [+client]',
  summary: 'Focus, due and late, waiting-on follow-ups, quiet projects',
  async run(k, p) {
    const day = k.today();
    const scope = p.projects[0];
    const ctx = await k.contextProject();
    const open = (await k.commitmentViews([eq(t.commitments.status, 'open')])).filter((v) => matchesScope(v, scope));
    const focusRows = await k.focusFor(day);
    const byId = new Map(open.map((v) => [v.c.id, v]));
    const focusedIds = new Set(focusRows.map((f) => f.commitmentId));

    const out: Block[] = [
      line([
        s(formatDay(day), 'muted'),
        ...(ctx ? [s(' · working on ', 'muted'), projectSpan(ctx)] : [s(' · not in a project', 'dim')]),
        ...(scope ? [s(` · showing +${scope}`, 'muted')] : []),
      ]),
    ];

    const priorities: Record<string, string> = JSON.parse((await k.getSetting(`priorities:${weekStart(day)}`)) ?? '{}');
    const clientHues = new Map((await k.listClients()).map((c) => [c.slug, c.color as Tone]));
    const weekly = Object.entries(priorities).filter(([slug]) => !scope || scope.split('/')[0] === slug);
    if (weekly.length) {
      out.push(blank(), heading('THIS WEEK', 'muted'), table(weekly.map(([slug, text]) => [s(slug, clientHues.get(slug) ?? 'muted'), s(text)])));
    }
    out.push(blank(), heading('FOCUS', 'accent'));

    const focusTable: Span[][] = [];
    for (let slot = 1; slot <= 3; slot++) {
      const f = focusRows.find((r) => r.slot === slot);
      const v = f ? byId.get(f.commitmentId) : undefined;
      focusTable.push(v ? [s(String(slot)), ...commitmentRow(v, day)] : [s(String(slot)), s('-', 'dim'), s('(empty)  focus <ref>', 'dim')]);
    }
    out.push(table(focusTable));

    const notFocused = open.filter((v) => !focusedIds.has(v.c.id));
    const dueOwe = notFocused.filter((v) => v.c.direction === 'owe' && v.c.dueOn <= day);
    const dueWait = notFocused.filter((v) => v.c.direction === 'wait' && v.c.dueOn <= day);
    const soon = notFocused.filter((v) => v.c.direction === 'owe' && v.c.dueOn > day && v.c.dueOn <= addDays(day, 3));

    const section = (title: string, tone: Tone | undefined, rows: CommitmentView[]) => {
      if (rows.length === 0) return;
      out.push(blank(), heading(title, tone), table(rows.map((v) => commitmentRow(v, day))));
    };
    section('I OWE · DUE AND LATE', undefined, dueOwe);
    section('WAITING ON · FOLLOW UP', 'wait', dueWait);
    section('COMING UP · NEXT 3 DAYS', 'muted', soon);

    const quiet = await quietProjects(k, open, scope);
    if (quiet.length) {
      out.push(blank(), heading('GOING QUIET'), table(quiet.map((q) => q.row)));
    }

    // Friday to Sunday, until this week's review is done.
    const lastReview = await k.getSetting('lastReviewAt');
    const dow = k.now().getDay();
    if ((dow === 5 || dow === 6 || dow === 0) && (!lastReview || formatLocal(lastReview) < weekStart(day))) {
      out.push(blank(), line([s('◆ ', 'accent'), s('Review day. Run '), s('review', 'accent', { bold: true }), s(' to close the week (about 30 min).')]));
    }

    const projectCount = ctx ? 1 : (await k.listProjects()).length;
    if (projectCount === 0) {
      out.push(
        blank(),
        hint('New here? Make a client and a project first. The project you work in decides where new items land:'),
        hint('  client new acme "Acme Corp"'),
        hint('  project new acme/website "Website rebuild"'),
      );
    } else if (!ctx) {
      out.push(blank(), hint('Pick the project you are working on: switch <client/project>. See them all with: projects'));
    }
    if (open.length === 0) {
      out.push(blank(), hint('Nothing open. Capture with: owe, wait or in'));
    } else if (focusRows.length === 0) {
      out.push(blank(), hint('Pick up to 3 for today: focus c12 c15'));
    }
    out.push(
      data({
        date: day,
        context: ctx ? projectData(ctx) : null,
        scope: scope ?? null,
        priorities: Object.fromEntries(weekly),
        focus: focusRows.map((f) => byId.get(f.commitmentId)).filter((v) => v !== undefined).map(commitmentData),
        dueAndLate: dueOwe.map(commitmentData),
        waitingFollowUp: dueWait.map(commitmentData),
        comingUp: soon.map(commitmentData),
        goingQuiet: quiet.map((q) => q.data),
      }),
    );
    return out;
  },
};

interface QuietProject {
  row: Span[];
  data: { project: string; open: number; untouchedDays: number };
}

async function quietProjects(k: Store, open: CommitmentView[], scope: string | undefined): Promise<QuietProject[]> {
  const rows: QuietProject[] = [];
  const projects = await k.listProjects();
  for (const pv of projects) {
    if (pv.project.status !== 'active') continue;
    if (scope && !(scope.includes('/') ? pv.path === scope : pv.path.startsWith(`${scope}/`))) continue;
    const count = open.filter((v) => v.project === pv.path).length;
    if (count === 0) continue;
    const last = pv.project.lastTouchedAt ?? pv.project.createdAt;
    const days = dayDiff(last.slice(0, 10), k.now().toISOString().slice(0, 10));
    if (days >= STALE_DAYS) {
      rows.push({
        row: [projectSpan(pv), s(`${count} open · untouched ${days}d`, 'muted')],
        data: { project: pv.path, open: count, untouchedDays: days },
      });
    }
  }
  return rows;
}

export const ls: Command = {
  name: 'ls',
  usage: 'ls [owe|wait|overdue|done|inbox] [+client] [@who]',
  summary: 'List commitments or the inbox, with filters',
  async run(k, p) {
    const what = (p.words[0] ?? 'open').toLowerCase();
    const day = k.today();
    const scope = p.projects[0];

    if (what === 'inbox') {
      const items = await k.openInbox();
      if (items.length === 0) return [hint('Inbox is empty.'), data({ inbox: [] })];
      const projects = new Map((await k.listProjects()).map((pv) => [pv.project.id, pv]));
      const kept = items
        .map((i) => ({ i, pv: i.projectId ? projects.get(i.projectId) : undefined }))
        .filter(({ pv }) => !scope || (pv && (scope.includes('/') ? pv.path === scope : pv.path.startsWith(`${scope}/`))));
      const rows = kept.map(({ i, pv }) => [s(`i${i.refNo}`, 'muted', { ref: `i${i.refNo}` }), s(i.text), pv ? projectSpan(pv) : s('-', 'dim')]);
      return [heading(`INBOX · ${rows.length}`), table(rows), data({ inbox: kept.map(({ i, pv }) => inboxData(i, pv?.path ?? null)) })];
    }

    const known = ['open', 'owe', 'wait', 'overdue', 'done'];
    if (!known.includes(what)) throw new KeelError(`Unknown list "${what}".`, `Try: ${[...known, 'inbox'].join(', ')}`);

    const status = what === 'done' ? 'done' : 'open';
    let rows = (await k.commitmentViews([eq(t.commitments.status, status)])).filter((v) => matchesScope(v, scope));
    if (p.people.length) rows = rows.filter((v) => p.people.includes(v.person));
    if (what === 'overdue') rows = rows.filter((v) => v.c.dueOn < day);

    const groups: Array<[string, CommitmentView[], Tone | undefined]> =
      what === 'owe' || what === 'wait'
        ? [[what === 'owe' ? 'I OWE' : 'WAITING ON', rows.filter((v) => v.c.direction === what), what === 'wait' ? 'wait' : undefined]]
        : [
            ['I OWE', rows.filter((v) => v.c.direction === 'owe'), undefined],
            ['WAITING ON', rows.filter((v) => v.c.direction === 'wait'), 'wait'],
          ];

    const out: Block[] = [];
    for (const [title, list, tone] of groups) {
      if (list.length === 0) continue;
      if (out.length) out.push(blank());
      out.push(heading(`${title} · ${list.length}`, tone), table(list.map((v) => commitmentRow(v, day))));
    }
    const result = data({ commitments: groups.flatMap(([, list]) => list).map(commitmentData) });
    return out.length ? [...out, result] : [hint('Nothing here.'), result];
  },
};

export const show: Command = {
  name: 'show',
  usage: 'show <c42|p7|i3>',
  summary: 'Details and history of one item',
  async run(k, p) {
    const ref = parseRef(p.words[0]);
    if (!ref) throw new KeelError('Which item?', 'Example: show c42, show p7, show i3');
    const day = k.today();

    if (ref.kind === 'c') {
      const v = await k.commitmentByRef(ref.n);
      const c = v.c;
      const out: Block[] = [
        line([s(`c${c.refNo}  `, 'muted'), s(c.title, 'default', { bold: true })]),
        table(
          [
            [s('direction', 'muted'), s(c.direction === 'owe' ? `I owe ${v.personName}` : `waiting on ${v.personName}`)],
            [s('due', 'muted'), s(`${formatDay(c.dueOn)} (${commitmentRow(v, day)[4]!.text})`)],
            [s('project', 'muted'), v.project ? s(v.project, v.hue ?? 'muted', { ref: `p${v.projectRef}` }) : s('-', 'dim')],
            [s('status', 'muted'), s(c.status)],
            [s('source', 'muted'), c.sourceRef ? s(`${c.source} · open link`, 'accent', { href: c.sourceRef }) : s(c.source)],
            ...(c.renegotiatedCount ? [[s('renegotiated', 'muted'), s(`${c.renegotiatedCount}x`)]] : []),
            ...(c.lastNudgedAt ? [[s('last nudged', 'muted'), s(formatDay(c.lastNudgedAt.slice(0, 10)))]] : []),
            ...(c.tags ? [[s('tags', 'muted'), s(c.tags.split(' ').map((x) => `#${x}`).join(' '))]] : []),
          ],
          2,
        ),
      ];
      const events = await k.eventsFor(c.id);
      return [
        ...out,
        ...historyBlocks(events),
        data({ ...commitmentData(v), history: events.map((e) => ({ at: e.createdAt, kind: e.kind, payload: e.payloadJson ? JSON.parse(e.payloadJson) : null })) }),
      ];
    }

    if (ref.kind === 'p') {
      const pv = await k.projectByRef(ref.n);
      if (!pv) throw new KeelError(`No project p${ref.n}.`, 'List them with: projects');
      const note = await k.latestResumeNote(pv.project.id);
      const openViews = await k.commitmentViews([eq(t.commitments.status, 'open'), eq(t.commitments.projectId, pv.project.id)]);
      const open = openViews.map((v) => commitmentRow(v, day));
      return [
        line([s(`p${pv.project.refNo}  `, 'muted'), projectSpan(pv), s(`  ${pv.project.name} · ${pv.project.status}`, 'muted')]),
        blank(),
        noteBlock(note, 'Resume note'),
        blank(),
        heading(`OPEN · ${open.length}`),
        ...(open.length ? [table(open)] : [hint('No open commitments.')]),
        data({ ...projectData(pv), resumeNote: noteData(note), open: openViews.map(commitmentData) }),
      ];
    }

    const item = await k.inboxByRef(ref.n);
    const project = item.projectId ? await k.projectById(item.projectId) : null;
    return [
      line([s(`i${item.refNo}  `, 'muted'), s(item.text, 'default', { bold: true })]),
      hint(`captured ${formatDay(item.createdAt.slice(0, 10))}${item.triagedAt ? ' · sorted' : ''}`),
      data(inboxData(item, project?.path ?? null)),
    ];
  },
};

export function noteBlock(note: { whereIAm: string | null; nextStep: string | null; unsureAbout: string | null; createdAt: string } | null, title: string): Block {
  if (!note) return hint('No resume note yet. Write one with: park where:"..." next:"..." unsure:"..."');
  return {
    kind: 'note',
    title: [s(title, 'default', { bold: true }), s(` · ${formatDay(note.createdAt.slice(0, 10))}`, 'muted')],
    fields: [
      { label: 'Where', value: note.whereIAm ?? '-' },
      { label: 'Next', value: note.nextStep ?? '-' },
      { label: 'Unsure', value: note.unsureAbout ?? '-' },
    ],
  };
}

function historyBlocks(events: Array<{ createdAt: string; kind: string }>): Block[] {
  if (events.length === 0) return [];
  return [
    blank(),
    heading('HISTORY', 'muted'),
    table(events.map((e) => [s(formatStamp(e.createdAt), 'muted'), s(e.kind)])),
  ];
}
