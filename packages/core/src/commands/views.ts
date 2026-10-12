import { eq } from 'drizzle-orm';
import { blank, heading, hint, line, s, table, type Block, type Span, type Tone } from '../blocks';
import { addDays, dayDiff, formatDay, formatStamp } from '../dates';
import * as t from '../db/schema';
import { KeelError } from '../errors';
import { parseRef } from '../parse';
import type { CommitmentView, Store } from '../store';
import { commitmentRow, matchesScope, projectSpan, type Command } from './shared';

const STALE_DAYS = 7;

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
        s(' · context ', 'muted'),
        ctx ? projectSpan(ctx) : s('none', 'dim'),
        ...(scope ? [s(` · showing +${scope}`, 'muted')] : []),
      ]),
      blank(),
      heading('FOCUS', 'accent'),
    ];

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
      out.push(blank(), heading('GOING QUIET'), table(quiet));
    }

    if (open.length === 0) {
      out.push(blank(), hint('Nothing open. Capture with: owe, wait or in'));
    } else if (focusRows.length === 0) {
      out.push(blank(), hint('Pick up to 3 for today: focus c12 c15'));
    }
    return out;
  },
};

async function quietProjects(k: Store, open: CommitmentView[], scope: string | undefined): Promise<Span[][]> {
  const rows: Span[][] = [];
  const projects = await k.listProjects();
  for (const pv of projects) {
    if (pv.project.status !== 'active') continue;
    if (scope && !(scope.includes('/') ? pv.path === scope : pv.path.startsWith(`${scope}/`))) continue;
    const count = open.filter((v) => v.project === pv.path).length;
    if (count === 0) continue;
    const last = pv.project.lastTouchedAt ?? pv.project.createdAt;
    const days = dayDiff(last.slice(0, 10), k.now().toISOString().slice(0, 10));
    if (days >= STALE_DAYS) rows.push([projectSpan(pv), s(`${count} open · untouched ${days}d`, 'muted')]);
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
      if (items.length === 0) return [hint('Inbox is empty.')];
      const projects = new Map((await k.listProjects()).map((pv) => [pv.project.id, pv]));
      const rows = items
        .map((i) => ({ i, pv: i.projectId ? projects.get(i.projectId) : undefined }))
        .filter(({ pv }) => !scope || (pv && (scope.includes('/') ? pv.path === scope : pv.path.startsWith(`${scope}/`))))
        .map(({ i, pv }) => [s(`i${i.refNo}`, 'muted', { ref: `i${i.refNo}` }), s(i.text), pv ? projectSpan(pv) : s('-', 'dim')]);
      return [heading(`INBOX · ${rows.length}`), table(rows)];
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
    return out.length ? out : [hint('Nothing here.')];
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
      return [...out, ...(await history(k, c.id))];
    }

    if (ref.kind === 'p') {
      const pv = await k.projectByRef(ref.n);
      if (!pv) throw new KeelError(`No project p${ref.n}.`, 'List them with: projects');
      const note = await k.latestResumeNote(pv.project.id);
      const open = (await k.commitmentViews([eq(t.commitments.status, 'open'), eq(t.commitments.projectId, pv.project.id)])).map(
        (v) => commitmentRow(v, day),
      );
      return [
        line([s(`p${pv.project.refNo}  `, 'muted'), projectSpan(pv), s(`  ${pv.project.name} · ${pv.project.status}`, 'muted')]),
        blank(),
        noteBlock(note, 'Resume note'),
        blank(),
        heading(`OPEN · ${open.length}`),
        ...(open.length ? [table(open)] : [hint('No open commitments.')]),
      ];
    }

    const item = await k.inboxByRef(ref.n);
    return [
      line([s(`i${item.refNo}  `, 'muted'), s(item.text, 'default', { bold: true })]),
      hint(`captured ${formatDay(item.createdAt.slice(0, 10))}${item.triagedAt ? ' · sorted' : ''}`),
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

async function history(k: Store, entityId: string): Promise<Block[]> {
  const events = await k.eventsFor(entityId);
  if (events.length === 0) return [];
  return [
    blank(),
    heading('HISTORY', 'muted'),
    table(events.map((e) => [s(formatStamp(e.createdAt), 'muted'), s(e.kind)])),
  ];
}
