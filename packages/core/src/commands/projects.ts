import { and, eq, isNull } from 'drizzle-orm';
import { blank, heading, hint, line, ok, s, table, warn, type Block } from '../blocks';
import { dayDiff } from '../dates';
import * as t from '../db/schema';
import { KeelError } from '../errors';
import { CLIENT_HUES } from '../palettes';
import type { Parsed } from '../parse';
import type { ProjectView, Store } from '../store';
import { commitmentRow, projectSpan, type Command } from './shared';
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
    return [ok([s('client '), s(slug, color, { bold: true }), s(` created · ${name}`)]), hint(`Next: project new ${slug}/<project> "Name"`)];
  },
};

async function listClients(k: Store): Promise<Block[]> {
  const clients = await k.listClients();
  if (clients.length === 0) return [hint('No clients yet. Add one: client new acme "Acme Corp"')];
  const projects = await k.listProjects();
  return [
    heading(`CLIENTS · ${clients.length}`),
    table(
      clients.map((c) => [
        s(c.slug, c.color as Parameters<typeof s>[1], { bold: true }),
        s(c.name),
        s(`${projects.filter((pv) => pv.client.id === c.id).length} projects`, 'muted'),
      ]),
    ),
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
    ];
  },
};

async function listProjects(k: Store): Promise<Block[]> {
  const projects = await k.listProjects();
  if (projects.length === 0) return [hint('No projects yet. Add one: project new acme/website "Website rebuild"')];
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
  ];
}

function noteFields(p: Parsed) {
  const { where, next, unsure } = p.kv;
  if (where === undefined && next === undefined && unsure === undefined) return null;
  return { whereIAm: where || null, nextStep: next || null, unsureAbout: unsure || null };
}

const NOTE_USAGE = 'park where:"..." next:"..." unsure:"..."';

export const switchCommand: Command = {
  name: 'switch',
  usage: 'switch <client/project> [where:"..." next:"..." unsure:"..."]',
  summary: 'Change context; shows the resume note waiting for you',
  async run(k, p) {
    const path = p.words[0] ?? p.projects[0];
    if (!path) throw new KeelError('Switch to which project?', 'Example: switch acme/website');
    const target = await k.projectByPath(path.replace(/^\+/, ''));
    const leaving = await k.contextProject();
    if (leaving?.project.id === target.project.id) return [warn(`Already in ${target.path}.`)];

    const at = k.iso();
    const openLog = await k.openContextLog();
    const fields = noteFields(p);
    const queries = [];
    if (openLog) queries.push(k.db.update(t.contextLog).set({ endedAt: at, updatedAt: at }).where(eq(t.contextLog.id, openLog.id)));
    if (leaving && fields) {
      queries.push(k.db.insert(t.resumeNotes).values({ id: k.newId(), ...k.stamps(), projectId: leaving.project.id, ...fields }));
    }
    queries.push(
      k.db.insert(t.contextLog).values({ id: k.newId(), ...k.stamps(), projectId: target.project.id, startedAt: at }),
      k.setSetting('context', target.project.id),
      k.db.update(t.projects).set({ lastTouchedAt: at, updatedAt: at }).where(eq(t.projects.id, target.project.id)),
      k.event('project', target.project.id, 'switched-in', { from: leaving?.path ?? null }),
    );

    // Check for a note on the project being left before writing anything.
    const out: Block[] = [];
    if (leaving) {
      const note = await k.latestResumeNote(leaving.project.id);
      const wroteNote = fields !== null || (note && openLog && note.createdAt >= openLog.startedAt);
      if (wroteNote) out.push(ok([s('Resume note saved for '), projectSpan(leaving)]));
      else out.push(warn([s('Left '), projectSpan(leaving), s(' without a resume note.')]), hint(`Next time: switch ${target.path} where:"..." next:"..." unsure:"..."`));
    }
    await k.batch(queries);

    const last = target.project.lastTouchedAt;
    const ago = last ? dayDiff(last.slice(0, 10), at.slice(0, 10)) : null;
    out.push(
      blank(),
      line([s('◆ ', 'accent'), s('Now in '), projectSpan(target), s(ago === null ? '' : ago === 0 ? ' · last here today' : ` · last here ${ago} days ago`, 'muted')]),
      blank(),
      noteBlock(await k.latestResumeNote(target.project.id), 'Resume note'),
    );

    const open = await k.commitmentViews([eq(t.commitments.status, 'open'), eq(t.commitments.projectId, target.project.id)]);
    if (open.length) {
      const day = k.today();
      out.push(blank(), heading(`OPEN HERE · ${open.length}`), table(open.map((v) => [s(v.c.direction === 'owe' ? 'owe' : 'wait', v.c.direction === 'owe' ? 'accent' : 'wait'), ...commitmentRow(v, day)])));
    }
    return out;
  },
};

export const park: Command = {
  name: 'park',
  usage: `${NOTE_USAGE} [+client/project]`,
  summary: 'Save a resume note and leave the project',
  async run(k, p) {
    const fields = noteFields(p);
    if (!fields) throw new KeelError('What should future you know?', `Example: ${NOTE_USAGE}`);
    const target = await k.projectFromArgs(p);
    if (!target) throw new KeelError('No project to park.', 'Switch to one first, or add +client/project.');
    const ctx = await k.getSetting('context');
    const at = k.iso();
    const queries = [
      k.db.insert(t.resumeNotes).values({ id: k.newId(), ...k.stamps(), projectId: target.project.id, ...fields }),
      k.db.update(t.projects).set({ lastTouchedAt: at, updatedAt: at }).where(eq(t.projects.id, target.project.id)),
      k.event('project', target.project.id, 'parked'),
    ];
    const leaving = ctx === target.project.id;
    if (leaving) {
      const openLog = await k.openContextLog();
      if (openLog) queries.push(k.db.update(t.contextLog).set({ endedAt: at, updatedAt: at }).where(eq(t.contextLog.id, openLog.id)));
      queries.push(k.setSetting('context', null));
    }
    await k.batch(queries);
    return [ok([s('Resume note saved for '), projectSpan(target), s(leaving ? '. Context cleared.' : '.')])];
  },
};
