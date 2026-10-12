import { and, eq, isNull } from 'drizzle-orm';
import { blank, data, heading, hint, line, ok, s, table, warn, type Block } from '../blocks';
import { dayDiff } from '../dates';
import * as t from '../db/schema';
import { KeelError } from '../errors';
import { CLIENT_HUES } from '../palettes';
import type { Parsed } from '../parse';
import type { ProjectView, Store } from '../store';
import { commitmentData, commitmentRow, noteData, projectData, projectSpan, type Command, type Flow } from './shared';
import { noteBlock } from './views';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export const client: Command = {
  name: 'client',
  usage: 'client new <slug> "<Name>" | client ls',
  summary: 'Add or list clients',
  async run(k, p) {
    const sub = p.words[0] ?? 'ls';
    if (sub === 'ls') return listClients(k);
    if (sub !== 'new') throw new KeelError(`Unknown "client ${sub}".`, 'Try: client new acme "Acme Corp", or client ls');

    const slug = (p.words[1] ?? '').toLowerCase();
    if (!SLUG.test(slug)) throw new KeelError('Give the client a short slug.', 'Example: client new acme "Acme Corp"');
    const name = p.words.slice(2).join(' ').trim() || slug;
    if (await k.clientBySlug(slug)) throw new KeelError(`Client ${slug} already exists.`);

    const count = (await k.listClients()).length;
    const color = CLIENT_HUES[count % CLIENT_HUES.length]!;
    const id = k.newId();
    await k.batch([
      k.db.insert(t.clients).values({ id, ...k.stamps(), slug, name, color }),
      k.event('client', id, 'created'),
    ]);
    return [
      ok([s('client '), s(slug, color, { bold: true }), s(` created · ${name}`)]),
      hint(`Next: project new ${slug}/<project> "Name"`),
      data({ id, slug, name }),
    ];
  },
};

async function listClients(k: Store): Promise<Block[]> {
  const clients = await k.listClients();
  if (clients.length === 0) return [hint('No clients yet. Add one: client new acme "Acme Corp"'), data({ clients: [] })];
  const projects = await k.listProjects();
  const count = (id: string) => projects.filter((pv) => pv.client.id === id).length;
  return [
    heading(`CLIENTS · ${clients.length}`),
    table(
      clients.map((c) => [
        s(c.slug, c.color as Parameters<typeof s>[1], { bold: true }),
        s(c.name),
        s(`${count(c.id)} projects`, 'muted'),
      ]),
    ),
    data({ clients: clients.map((c) => ({ id: c.id, slug: c.slug, name: c.name, projects: count(c.id) })) }),
  ];
}

export const project: Command = {
  name: 'project',
  usage: 'project new <client/slug> "<Name>" | project ls',
  summary: 'Add or list projects',
  async run(k, p) {
    const sub = p.words[0] ?? 'ls';
    if (sub === 'ls') return listProjects(k);
    if (sub !== 'new') throw new KeelError(`Unknown "project ${sub}".`, 'Try: project new acme/website "Website rebuild", or project ls');

    const path = (p.words[1] ?? p.projects[0] ?? '').toLowerCase();
    const [clientSlug, slug] = path.split('/');
    if (!clientSlug || !slug || !SLUG.test(slug)) {
      throw new KeelError('Name it client/project.', 'Example: project new acme/website "Website rebuild"');
    }
    const owner = await k.clientBySlug(clientSlug);
    if (!owner) throw new KeelError(`No client ${clientSlug}.`, `Create it first: client new ${clientSlug} "Name"`);
    const exists = await k.db
      .select()
      .from(t.projects)
      .where(and(eq(t.projects.clientId, owner.id), eq(t.projects.slug, slug), isNull(t.projects.deletedAt)));
    if (exists[0]) throw new KeelError(`Project ${path} already exists.`);

    const name = p.words.slice(2).join(' ').trim() || slug;
    const id = k.newId();
    const refNo = await k.nextRef(t.projects);
    const hadContext = Boolean(await k.getSetting('context'));
    const queries = [
      k.db.insert(t.projects).values({ id, ...k.stamps(), refNo, clientId: owner.id, slug, name, lastTouchedAt: k.iso() }),
      k.event('project', id, 'created'),
    ];
    if (!hadContext) {
      queries.push(k.setSetting('context', id), k.db.insert(t.contextLog).values({ id: k.newId(), ...k.stamps(), projectId: id, startedAt: k.iso() }));
    }
    await k.batch(queries);
    const view = { path: `${clientSlug}/${slug}`, hue: owner.color as ProjectView['hue'], project: { refNo } as ProjectView['project'] };
    return [
      ok([s(`p${refNo}`, 'default', { bold: true, ref: `p${refNo}` }), s(' '), projectSpan(view), s(` created · ${name}`)]),
      hint(hadContext ? `Work on it with: switch ${view.path}` : `Context set to ${view.path}. New items land here.`),
      data(projectData((await k.projectByRef(refNo))!)),
    ];
  },
};

async function listProjects(k: Store): Promise<Block[]> {
  const projects = await k.listProjects();
  if (projects.length === 0) return [hint('No projects yet. Add one: project new acme/website "Website rebuild"'), data({ projects: [] })];
  const ctx = await k.getSetting('context');
  return [
    heading(`PROJECTS · ${projects.length}`),
    table(
      projects.map((pv) => [
        s(pv.project.id === ctx ? '●' : ' ', pv.hue),
        s(`p${pv.project.refNo}`, 'muted', { ref: `p${pv.project.refNo}` }),
        projectSpan(pv),
        s(pv.project.name),
        s(pv.project.status, pv.project.status === 'active' ? 'muted' : 'today'),
      ]),
    ),
    data({ projects: projects.map((pv) => ({ ...projectData(pv), current: pv.project.id === ctx })) }),
  ];
}

export interface NoteFields {
  whereIAm: string | null;
  nextStep: string | null;
  unsureAbout: string | null;
}

function noteFields(p: Parsed): NoteFields | null {
  const { where, next, unsure } = p.kv;
  if (where === undefined && next === undefined && unsure === undefined) return null;
  return { whereIAm: where || null, nextStep: next || null, unsureAbout: unsure || null };
}

/** Asks the three resume-note questions. Returns null when every answer was skipped. */
export async function* askNote(project: Pick<ProjectView, 'path' | 'hue' | 'project'>, intro: string): Flow<NoteFields | null> {
  const skip = 'enter on an empty line skips';
  const where = yield {
    blocks: [line([s('◆ ', 'accent'), s(`${intro} `), projectSpan(project)])],
    question: { prompt: 'Where are you?', hint: skip },
  };
  const next = yield { blocks: [], question: { prompt: "What's next?", hint: skip } };
  const unsure = yield { blocks: [], question: { prompt: 'Unsure about?', hint: skip } };
  const clean = (x: string) => x.trim() || null;
  if (!clean(where) && !clean(next) && !clean(unsure)) return null;
  return { whereIAm: clean(where), nextStep: clean(next), unsureAbout: clean(unsure) };
}

export function saveNote(k: Store, projectId: string, fields: NoteFields) {
  const at = k.iso();
  return [
    k.db.insert(t.resumeNotes).values({ id: k.newId(), ...k.stamps(), projectId, ...fields }),
    k.db.update(t.projects).set({ lastTouchedAt: at, updatedAt: at }).where(eq(t.projects.id, projectId)),
  ];
}

export const switchCommand: Command = {
  name: 'switch',
  usage: 'switch <client/project> [where:"..." next:"..." unsure:"..."]',
  summary: 'Change context; asks for a resume note on the way out',
  async *flow(k, p) {
    const path = p.words[0] ?? p.projects[0];
    if (!path) throw new KeelError('Switch to which project?', 'Example: switch acme/website');
    const target = await k.projectByPath(path.replace(/^\+/, ''));
    const leaving = await k.contextProject();
    if (leaving?.project.id === target.project.id) return [warn(`Already in ${target.path}.`), data({ context: projectData(target), left: null })];

    const out: Block[] = [];
    const openLog = await k.openContextLog();
    let fields = noteFields(p);
    if (leaving && !fields) {
      const note = await k.latestResumeNote(leaving.project.id);
      const fresh = note && openLog && note.createdAt >= openLog.startedAt;
      if (!fresh) {
        const minutes = openLog ? Math.round((k.now().getTime() - new Date(openLog.startedAt).getTime()) / 60_000) : 0;
        fields = yield* askNote(leaving, minutes >= 1 ? `Leaving after ${formatDuration(minutes)}. Resume note for` : 'Resume note for');
        if (!fields) out.push(warn([s('Left '), projectSpan(leaving), s(' without a resume note.')]));
      }
    }

    const at = k.iso();
    const queries = [];
    if (openLog) queries.push(k.db.update(t.contextLog).set({ endedAt: at, updatedAt: at }).where(eq(t.contextLog.id, openLog.id)));
    if (leaving && fields) {
      queries.push(...saveNote(k, leaving.project.id, fields));
      out.push(ok([s('Resume note saved for '), projectSpan(leaving)]));
    }
    queries.push(
      k.db.insert(t.contextLog).values({ id: k.newId(), ...k.stamps(), projectId: target.project.id, startedAt: at }),
      k.setSetting('context', target.project.id),
      k.db.update(t.projects).set({ lastTouchedAt: at, updatedAt: at }).where(eq(t.projects.id, target.project.id)),
      k.event('project', target.project.id, 'switched-in', { from: leaving?.path ?? null }),
    );
    await k.batch(queries);

    const last = target.project.lastTouchedAt;
    const ago = last ? dayDiff(last.slice(0, 10), at.slice(0, 10)) : null;
    if (out.length) out.push(blank());
    const note = await k.latestResumeNote(target.project.id);
    out.push(
      line([s('◆ ', 'accent'), s('Now in '), projectSpan(target), s(ago === null ? '' : ago === 0 ? ' · last here today' : ` · last here ${ago} days ago`, 'muted')]),
      blank(),
      noteBlock(note, 'Resume note'),
    );

    const open = await k.commitmentViews([eq(t.commitments.status, 'open'), eq(t.commitments.projectId, target.project.id)]);
    if (open.length) {
      const day = k.today();
      out.push(
        blank(),
        heading(`OPEN HERE · ${open.length}`),
        table(open.map((v) => [s(v.c.direction, v.c.direction === 'owe' ? 'accent' : 'wait'), ...commitmentRow(v, day)])),
      );
    }
    out.push(
      data({
        context: projectData(target),
        left: leaving ? { project: leaving.path, resumeNoteSaved: Boolean(fields) } : null,
        resumeNote: noteData(note),
        open: open.map(commitmentData),
      }),
    );
    return out;
  },
};

export const park: Command = {
  name: 'park',
  usage: 'park [where:"..." next:"..." unsure:"..."] [+client/project]',
  summary: 'Save a resume note and leave the project',
  async *flow(k, p) {
    const target = await k.projectFromArgs(p);
    if (!target) throw new KeelError('No project to park.', 'Switch to one first, or add +client/project.');
    const fields = noteFields(p) ?? (yield* askNote(target, 'Resume note for'));
    if (!fields) return [warn('Nothing saved.'), data({ project: projectData(target), saved: false, contextCleared: false })];

    const ctx = await k.getSetting('context');
    const at = k.iso();
    const queries = [...saveNote(k, target.project.id, fields), k.event('project', target.project.id, 'parked')];
    const leaving = ctx === target.project.id;
    if (leaving) {
      const openLog = await k.openContextLog();
      if (openLog) queries.push(k.db.update(t.contextLog).set({ endedAt: at, updatedAt: at }).where(eq(t.contextLog.id, openLog.id)));
      queries.push(k.setSetting('context', null));
    }
    await k.batch(queries);
    return [
      ok([s('Resume note saved for '), projectSpan(target), s(leaving ? '. Context cleared.' : '.')]),
      data({ project: projectData(target), saved: true, resumeNote: fields, contextCleared: leaving }),
    ];
  },
};

/** "2h 10m", "45m" */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
