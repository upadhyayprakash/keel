import { s, type Block, type Question, type Span } from '../blocks';
import { describeDue } from '../dates';
import { KeelError } from '../errors';
import { goalRef, type GoalView } from '../goals';
import { parseRef, type Parsed } from '../parse';
import type { CommitmentView, InboxItem, ProjectView, ResumeNote, Store } from '../store';

/** One pause in an interactive command: what to show, then what to ask. */
export interface Step {
  blocks: Block[];
  question: Question;
}

/** Interactive commands are async generators: they yield questions and receive the answers. */
export type Flow<T = Block[]> = AsyncGenerator<Step, T, string>;

export interface Command {
  name: string;
  aliases?: string[];
  usage: string;
  summary: string;
  run?(k: Store, p: Parsed): Promise<Block[]>;
  flow?(k: Store, p: Parsed): Flow;
  /** Handles --json itself instead of getting the standard { ok, data, text } wrapper (export). */
  ownsJson?: boolean;
}

export const SOURCES = ['meeting', 'slack', 'email', 'claude', 'other'] as const;
export type Source = (typeof SOURCES)[number];

/** `from:slack:https://...` becomes { source: 'slack', sourceRef: 'https://...' }. */
export function parseSource(from: string | undefined): { source: Source; sourceRef: string | null } {
  if (!from) return { source: 'other', sourceRef: null };
  const idx = from.indexOf(':');
  const kind = (idx === -1 ? from : from.slice(0, idx)).toLowerCase();
  const ref = idx === -1 ? null : from.slice(idx + 1) || null;
  if (!(SOURCES as readonly string[]).includes(kind)) {
    throw new KeelError(`Unknown source "${kind}".`, `Use one of: ${SOURCES.join(', ')}. Add a link after a colon: from:slack:<link>`);
  }
  return { source: kind as Source, sourceRef: ref };
}

export function projectSpan(v: Pick<ProjectView, 'path' | 'hue' | 'project'>): Span {
  return s(v.path, v.hue, { ref: `p${v.project.refNo}` });
}

/** One commitment as a table row: ref, title, person, project, due. */
export function commitmentRow(v: CommitmentView, today: string): Span[] {
  const ref = `c${v.c.refNo}`;
  const due =
    v.c.status === 'open' ? describeDue(v.c.dueOn, today) : { text: v.c.status, tone: v.c.status === 'done' ? 'done' : 'dim' };
  return [
    s(ref, 'muted', { ref }),
    s(v.c.title),
    s(`@${v.person}`, 'muted'),
    v.project ? s(v.project, v.hue ?? 'muted', { ref: `p${v.projectRef}` }) : s('-', 'dim'),
    s(due.text, due.tone as Span['tone']),
  ];
}

/** Reads a single ref like c42 from the first word, checking its kind. */
export function refArg(p: Parsed, kinds: Array<'c' | 'p' | 'i'>, usage: string) {
  const ref = parseRef(p.words[0]);
  if (!ref || !kinds.includes(ref.kind)) throw new KeelError(`Which item? ${usage}`);
  return ref;
}

/** Keeps commitments that belong to +client or +client/project, when one is given. */
export function matchesScope(v: CommitmentView, scope: string | undefined): boolean {
  if (!scope) return true;
  if (!v.project) return false;
  return scope.includes('/') ? v.project === scope : v.project.startsWith(`${scope}/`);
}

// ---- --json shapes. Field names are a public contract (scripts, MCP), so change them with care. ----

export function commitmentData(v: CommitmentView) {
  const c = v.c;
  return {
    ref: `c${c.refNo}`,
    id: c.id,
    direction: c.direction,
    title: c.title,
    person: v.person,
    personName: v.personName,
    project: v.project,
    dueOn: c.dueOn,
    status: c.status,
    source: c.source,
    sourceRef: c.sourceRef,
    tags: c.tags ? c.tags.split(' ') : [],
    renegotiatedCount: c.renegotiatedCount,
    lastNudgedAt: c.lastNudgedAt,
    createdAt: c.createdAt,
    closedAt: c.closedAt,
  };
}

export function projectData(pv: ProjectView) {
  return {
    ref: `p${pv.project.refNo}`,
    id: pv.project.id,
    path: pv.path,
    name: pv.project.name,
    client: pv.client.slug,
    clientName: pv.client.name,
    status: pv.project.status,
    lastTouchedAt: pv.project.lastTouchedAt,
  };
}

export function inboxData(item: InboxItem, project: string | null) {
  return {
    ref: `i${item.refNo}`,
    id: item.id,
    text: item.text,
    project,
    source: item.source,
    createdAt: item.createdAt,
    triagedAt: item.triagedAt,
    deleted: Boolean(item.deletedAt),
  };
}

export function goalData({ goal, steps }: GoalView) {
  return {
    ref: goalRef(goal),
    id: goal.id,
    title: goal.title,
    doneMeans: goal.doneMeans,
    dueOn: goal.dueOn,
    appetite: goal.appetite,
    obstacle: goal.obstacle,
    plan: goal.plan,
    status: goal.status,
    progress: { done: steps.filter((st) => st.status === 'done').length, total: steps.length },
    steps: steps.map((st) => ({
      position: st.position,
      text: st.text,
      cueAt: st.cueAt,
      cuePlace: st.cuePlace,
      minimum: st.minimum,
      firstStep: st.firstStep,
      status: st.status,
      doneAt: st.doneAt,
    })),
    createdAt: goal.createdAt,
    closedAt: goal.closedAt,
  };
}

export function noteData(note: ResumeNote | null) {
  return note ? { whereIAm: note.whereIAm, nextStep: note.nextStep, unsureAbout: note.unsureAbout, createdAt: note.createdAt } : null;
}
