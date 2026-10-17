import { and, eq, inArray, isNull } from 'drizzle-orm';
import { data, heading, hint, ok, s, table, warn, type Block } from '../blocks';
import { weekStart } from '../dates';
import * as t from '../db/schema';
import { KeelError } from '../errors';
import { SELF, isSelf } from '../self';
import { CLIENT_HUES } from '../palettes';
import type { Parsed } from '../parse';
import type { ProjectView, Store } from '../store';
import { projectData, projectSpan, refArg, type Command, type Flow } from './shared';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

// Deletes are soft (deleted_at is set, Turso-ready rule 6), so daily backups and
// exports before the delete still hold everything. The slug or handle gets the row
// id appended, which frees the name for reuse.
const freed = (name: string, id: string) => `${name}~${id}`;

// ---- clients ----

export const client: Command = {
  name: 'client',
  usage: 'client new|rename|archive|unarchive|delete <slug> ... | clients [--all]',
  summary: 'Add, rename, archive or delete clients',
  async *flow(k, p) {
    const sub = p.words[0] ?? 'ls';
    if (sub === 'ls') return listClients(k, p.flags.has('all'));
    if (sub === 'new') return newClient(k, p);
    if (sub === 'rename') return renameClient(k, p);
    if (sub === 'archive' || sub === 'unarchive') return archiveClient(k, p, sub === 'archive');
    if (sub === 'delete') return yield* deleteClient(k, p);
    throw new KeelError(`Unknown "client ${sub}".`, 'Try: client new, client rename, client archive, client delete, or clients');
  },
};

async function newClient(k: Store, p: Parsed): Promise<Block[]> {
  const slug = (p.words[1] ?? '').toLowerCase();
  if (!SLUG.test(slug)) throw new KeelError('Give the client a short slug.', 'Example: client new acme "Acme Corp"');
  const name = p.words.slice(2).join(' ').trim() || slug;
  if (await k.clientBySlug(slug)) throw new KeelError(`Client ${slug} already exists.`);

  const count = (await k.listClients(true)).length;
  const color = CLIENT_HUES[count % CLIENT_HUES.length]!;
  const id = k.newId();
  await k.batch([k.db.insert(t.clients).values({ id, ...k.stamps(), slug, name, color }), k.event('client', id, 'created')]);
  return [
    ok([s('client '), s(slug, color, { bold: true }), s(` created · ${name}`)]),
    hint(`Next: project new ${slug}/<project> "Name"`),
    data({ id, slug, name }),
  ];
}

async function listClients(k: Store, all: boolean): Promise<Block[]> {
  const clients = await k.listClients(all);
  if (clients.length === 0) return [hint('No clients yet. Add one: client new acme "Acme Corp"'), data({ clients: [] })];
  const projects = await k.listProjects(true);
  const count = (id: string) => projects.filter((pv) => pv.client.id === id).length;
  const archived = all ? 0 : (await k.listClients(true)).length - clients.length;
  return [
    heading(`CLIENTS · ${clients.length}`),
    table(
      clients.map((c) => [
        s(c.slug, c.color as Parameters<typeof s>[1], { bold: true }),
        s(c.name),
        s(`${count(c.id)} projects`, 'muted'),
        ...(c.archivedAt ? [s('archived', 'today')] : []),
      ]),
    ),
    ...(archived ? [hint(`${archived} archived. Show them with: clients --all`)] : []),
    data({ clients: clients.map((c) => ({ id: c.id, slug: c.slug, name: c.name, projects: count(c.id), archived: Boolean(c.archivedAt) })) }),
  ];
}

async function renameClient(k: Store, p: Parsed): Promise<Block[]> {
  const usage = 'Example: client rename acme "Acme Inc", or client rename acme slug:acme-inc';
  const c = await k.requireClient(p.words[1], usage);
  const name = p.words.slice(2).join(' ').trim();
  const slug = p.kv.slug?.toLowerCase();
  if (!name && !slug) throw new KeelError('What is the new name?', usage);
  if (slug !== undefined) {
    if (!SLUG.test(slug)) throw new KeelError(`"${slug}" can't be a slug.`, 'Use lowercase letters, numbers and dashes.');
    if (slug !== c.slug && (await k.clientBySlug(slug))) throw new KeelError(`Client ${slug} already exists.`);
  }

  const at = k.iso();
  const changes = { ...(name ? { name } : {}), ...(slug ? { slug } : {}) };
  const queries = [k.db.update(t.clients).set({ ...changes, updatedAt: at }).where(eq(t.clients.id, c.id)), k.event('client', c.id, 'renamed', changes)];
  // This week's priorities are keyed by client slug; carry them over.
  if (slug && slug !== c.slug) {
    const key = `priorities:${weekStart(k.today())}`;
    const priorities: Record<string, string> = JSON.parse((await k.getSetting(key)) ?? '{}');
    if (priorities[c.slug] !== undefined) {
      priorities[slug] = priorities[c.slug]!;
      delete priorities[c.slug];
      queries.push(k.setSetting(key, JSON.stringify(priorities)));
    }
  }
  await k.batch(queries);
  const now = { slug: slug ?? c.slug, name: name || c.name };
  return [
    ok([s('client '), s(now.slug, c.color as Parameters<typeof s>[1], { bold: true }), s(` · ${now.name}`)]),
    ...(slug && slug !== c.slug ? [hint(`Its projects are now ${slug}/...`)] : []),
    data({ id: c.id, ...now }),
  ];
}

async function archiveClient(k: Store, p: Parsed, archive: boolean): Promise<Block[]> {
  const verb = archive ? 'archive' : 'unarchive';
  const c = await k.requireClient(p.words[1], `Example: client ${verb} acme`);
  if (Boolean(c.archivedAt) === archive) return [warn(`${c.slug} is already ${archive ? 'archived' : 'active'}.`), data({ slug: c.slug, archived: archive })];

  const at = k.iso();
  const queries = [
    k.db.update(t.clients).set({ archivedAt: archive ? at : null, updatedAt: at }).where(eq(t.clients.id, c.id)),
    k.event('client', c.id, archive ? 'archived' : 'unarchived'),
  ];
  const out: Block[] = [];
  if (archive) {
    const ids = (await k.listProjects(true)).filter((pv) => pv.client.id === c.id).map((pv) => pv.project.id);
    queries.push(...(await leaveIfInside(k, ids, at)));
    const open = await openCount(k, ids);
    out.push(ok([s('client '), s(c.slug, c.color as Parameters<typeof s>[1], { bold: true }), s(' archived. It and its projects are hidden from lists.')]));
    if (open) out.push(hint(`${open} open commitment${open === 1 ? '' : 's'} stay in today and ls until you close them.`));
    out.push(hint(`Bring it back with: client unarchive ${c.slug}`));
  } else {
    out.push(ok([s('client '), s(c.slug, c.color as Parameters<typeof s>[1], { bold: true }), s(' is active again.')]));
  }
  await k.batch(queries);
  return [...out, data({ slug: c.slug, archived: archive })];
}

async function* deleteClient(k: Store, p: Parsed): Flow {
  const c = await k.requireClient(p.words[1], 'Example: client delete acme');
  const ids = (await k.listProjects(true)).filter((pv) => pv.client.id === c.id).map((pv) => pv.project.id);
  const plan = await deletionPlan(k, ids);
  const summary = `client ${c.slug} (${c.name}) with ${plural(ids.length, 'project')}, ${describePlan(plan)}`;

  // --yes skips the question (for scripts). Without it, deleting always asks, and --json answers no.
  if (!p.flags.has('yes')) {
    const answer = yield confirmStep(summary, c.slug);
    if (answer.trim() !== c.slug) return [warn('Nothing deleted.'), data({ deleted: false })];
  }
  const at = k.iso();
  await k.batch([
    ...(await deleteProjectsQueries(k, ids, at)),
    k.db.update(t.clients).set({ deletedAt: at, updatedAt: at, slug: freed(c.slug, c.id) }).where(eq(t.clients.id, c.id)),
    k.event('client', c.id, 'deleted', { slug: c.slug, ...plan, projects: ids.length }),
  ]);
  return [ok(`Deleted ${summary}.`), data({ deleted: true, client: c.slug, projects: ids.length, ...plan })];
}

// ---- projects ----

export const project: Command = {
  name: 'project',
  usage: 'project new <client/slug> "<Name>" | project delete <p7> | projects [--all]',
  summary: 'Add, list or delete projects (rename with set p7 title:"..." slug:...)',
  async *flow(k, p) {
    const sub = p.words[0] ?? 'ls';
    if (sub === 'ls') return listProjects(k, p.flags.has('all'));
    if (sub === 'new') return newProject(k, p);
    if (sub === 'delete') return yield* deleteProject(k, p);
    throw new KeelError(`Unknown "project ${sub}".`, 'Try: project new acme/website "Website rebuild", project delete p7, or projects');
  },
};

async function newProject(k: Store, p: Parsed): Promise<Block[]> {
  const path = (p.words[1] ?? p.projects[0] ?? '').toLowerCase();
  const [clientSlug, slug] = path.split('/');
  if (!clientSlug || !slug || !SLUG.test(slug)) {
    throw new KeelError('Name it client/project.', 'Example: project new acme/website "Website rebuild"');
  }
  const owner = await k.clientBySlug(clientSlug);
  if (!owner) throw new KeelError(`No client ${clientSlug}.`, `Create it first: client new ${clientSlug} "Name"`);
  if (owner.archivedAt) throw new KeelError(`${clientSlug} is archived.`, `Bring it back first: client unarchive ${clientSlug}`);
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
    hint(hadContext ? `Work on it with: switch ${view.path}` : `You are now working on ${view.path}. New items land here.`),
    data(projectData((await k.projectByRef(refNo))!)),
  ];
}

async function listProjects(k: Store, all: boolean): Promise<Block[]> {
  const projects = await k.listProjects(all);
  if (projects.length === 0) return [hint('No projects yet. Add one: project new acme/website "Website rebuild"'), data({ projects: [] })];
  const ctx = await k.getSetting('context');
  const hidden = all ? 0 : (await k.listProjects(true)).length - projects.length;
  return [
    heading(`PROJECTS · ${projects.length}`),
    table(
      projects.map((pv) => [
        s(pv.project.id === ctx ? '●' : ' ', pv.hue),
        s(`p${pv.project.refNo}`, 'muted', { ref: `p${pv.project.refNo}` }),
        projectSpan(pv),
        s(pv.project.name),
        s(pv.client.archivedAt ? 'client archived' : pv.project.status, pv.project.status === 'active' && !pv.client.archivedAt ? 'muted' : 'today'),
      ]),
    ),
    ...(hidden ? [hint(`${hidden} more under archived clients. Show them with: projects --all`)] : []),
    data({ projects: projects.map((pv) => ({ ...projectData(pv), current: pv.project.id === ctx })) }),
  ];
}

async function* deleteProject(k: Store, p: Parsed): Flow {
  const arg = p.words[1] ?? p.projects[0];
  const usage = 'Example: project delete p7, or project delete acme/website';
  if (!arg) throw new KeelError('Which project?', usage);
  let pv: ProjectView | null;
  if (/^p\d+$/i.test(arg)) {
    const ref = refArg({ ...p, words: [arg] }, ['p'], usage);
    pv = (await k.listProjects(true)).find((x) => x.project.refNo === ref.n) ?? null;
    if (!pv) throw new KeelError(`No project ${arg}.`, 'List them with: projects --all');
  } else {
    const path = arg.replace(/^\+/, '').toLowerCase();
    pv = (await k.listProjects(true)).find((x) => x.path === path) ?? null;
    if (!pv) throw new KeelError(`No project ${path}.`, 'List them with: projects --all');
  }

  const plan = await deletionPlan(k, [pv.project.id]);
  const summary = `project ${pv.path} (${pv.project.name}) with ${describePlan(plan)}`;
  if (!p.flags.has('yes')) {
    const answer = yield confirmStep(summary, pv.path);
    if (answer.trim().replace(/^\+/, '') !== pv.path) return [warn('Nothing deleted.'), data({ deleted: false })];
  }
  const at = k.iso();
  await k.batch([...(await deleteProjectsQueries(k, [pv.project.id], at)), k.event('project', pv.project.id, 'deleted', { path: pv.path, ...plan })]);
  return [ok(`Deleted ${summary}.`), data({ deleted: true, project: pv.path, ...plan })];
}

// ---- shared delete helpers ----

interface Plan {
  commitments: number;
  resumeNotes: number;
  inboxItems: number;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const describePlan = (plan: Plan) =>
  `${plural(plan.commitments, 'commitment')}, ${plural(plan.resumeNotes, 'resume note')} and ${plural(plan.inboxItems, 'inbox item')}`;

function confirmStep(summary: string, name: string) {
  return {
    blocks: [warn(`This deletes ${summary}.`), hint('Deleted items disappear from Keel. Your daily backups and exports from before today still have them.')],
    question: { prompt: `Type ${name} to confirm`, hint: 'anything else cancels' },
  };
}

async function deletionPlan(k: Store, projectIds: string[]): Promise<Plan> {
  if (projectIds.length === 0) return { commitments: 0, resumeNotes: 0, inboxItems: 0 };
  const live = <T extends typeof t.commitments | typeof t.resumeNotes | typeof t.inboxItems>(table: T) =>
    k.db
      .select({ id: table.id })
      .from(table as typeof t.commitments)
      .where(and(inArray((table as typeof t.commitments).projectId, projectIds), isNull((table as typeof t.commitments).deletedAt)));
  return {
    commitments: (await live(t.commitments)).length,
    resumeNotes: (await live(t.resumeNotes)).length,
    inboxItems: (await live(t.inboxItems)).length,
  };
}

async function deleteProjectsQueries(k: Store, projectIds: string[], at: string) {
  if (projectIds.length === 0) return [];
  const gone = { deletedAt: at, updatedAt: at };
  const projects = await k.db.select().from(t.projects).where(inArray(t.projects.id, projectIds));
  return [
    k.db.update(t.commitments).set(gone).where(and(inArray(t.commitments.projectId, projectIds), isNull(t.commitments.deletedAt))),
    k.db.update(t.resumeNotes).set(gone).where(and(inArray(t.resumeNotes.projectId, projectIds), isNull(t.resumeNotes.deletedAt))),
    k.db.update(t.inboxItems).set(gone).where(and(inArray(t.inboxItems.projectId, projectIds), isNull(t.inboxItems.deletedAt))),
    ...projects.map((pr) => k.db.update(t.projects).set({ ...gone, slug: freed(pr.slug, pr.id) }).where(eq(t.projects.id, pr.id))),
    ...(await leaveIfInside(k, projectIds, at)),
  ];
}

/** If you're working on one of these projects, end that session and clear it. */
async function leaveIfInside(k: Store, projectIds: string[], at: string) {
  const ctx = await k.getSetting('context');
  if (!ctx || !projectIds.includes(ctx)) return [];
  const log = await k.openContextLog();
  return [
    k.setSetting('context', null),
    ...(log ? [k.db.update(t.contextLog).set({ endedAt: at, updatedAt: at }).where(eq(t.contextLog.id, log.id))] : []),
  ];
}

async function openCount(k: Store, projectIds: string[]): Promise<number> {
  if (projectIds.length === 0) return 0;
  const rows = await k.db
    .select({ id: t.commitments.id })
    .from(t.commitments)
    .where(and(inArray(t.commitments.projectId, projectIds), eq(t.commitments.status, 'open'), isNull(t.commitments.deletedAt)));
  return rows.length;
}

// ---- people ----

export const person: Command = {
  name: 'person',
  usage: 'person rename @ravi "Ravi Kumar" | person merge @rav @ravi | people',
  summary: 'List people, set their names, merge duplicates',
  async run(k, p) {
    const sub = p.words[0] ?? 'ls';
    if (sub === 'ls') return listPeople(k);
    if (sub === 'rename') {
      const handle = p.people[0];
      const name = p.words.slice(1).join(' ').trim();
      if (!handle || !name) throw new KeelError('Who, and what name?', 'Example: person rename @ravi "Ravi Kumar"');
      if (isSelf(handle)) throw new KeelError(`@${SELF} is always you.`, 'It shows as "for myself" and has no name to set.');
      const who = await k.personByHandle(handle);
      await k.batch([
        k.db.update(t.people).set({ name, updatedAt: k.iso() }).where(eq(t.people.id, who.id)),
        k.event('person', who.id, 'renamed', { from: who.name, to: name }),
      ]);
      return [ok([s(`@${who.handle}`, 'default', { bold: true }), s(` is now ${name}`)]), data({ handle: who.handle, name })];
    }
    if (sub === 'merge') {
      const [fromHandle, intoHandle] = p.people;
      if (!fromHandle || !intoHandle) throw new KeelError('Merge whom into whom?', 'Example: person merge @rav @ravi (moves everything from @rav to @ravi)');
      if (fromHandle === intoHandle) throw new KeelError('That is the same person.');
      if (isSelf(fromHandle)) throw new KeelError(`@${SELF} is always you and can't be merged into someone else.`);
      const from = await k.personByHandle(fromHandle);
      // @me may not exist yet: create it on the way in.
      const self = isSelf(intoHandle) ? await k.person(SELF) : null;
      const into = self ? { id: self.id, handle: SELF } : await k.personByHandle(intoHandle);
      if (self) {
        const waits = await k.db
          .select({ id: t.commitments.id })
          .from(t.commitments)
          .where(and(eq(t.commitments.personId, from.id), eq(t.commitments.direction, 'wait'), eq(t.commitments.status, 'open'), isNull(t.commitments.deletedAt)));
        if (waits.length) throw new KeelError(`@${from.handle} has things you're waiting on, and you can't wait on yourself.`, 'Move or close those first, then merge.');
      }
      const moved = await k.db
        .select({ id: t.commitments.id })
        .from(t.commitments)
        .where(and(eq(t.commitments.personId, from.id), isNull(t.commitments.deletedAt)));
      const at = k.iso();
      await k.batch([
        ...(self?.queries ?? []),
        k.db.update(t.commitments).set({ personId: into.id, updatedAt: at }).where(eq(t.commitments.personId, from.id)),
        k.db.update(t.people).set({ deletedAt: at, updatedAt: at, handle: freed(from.handle, from.id) }).where(eq(t.people.id, from.id)),
        k.event('person', from.id, 'merged', { into: into.handle, commitments: moved.length }),
      ]);
      return [
        ok([s(`@${from.handle}`, 'default', { bold: true }), s(' merged into '), s(`@${into.handle}`, 'default', { bold: true }), s(` · ${plural(moved.length, 'commitment')} moved`)]),
        data({ from: from.handle, into: into.handle, commitments: moved.length }),
      ];
    }
    throw new KeelError(`Unknown "person ${sub}".`, 'Try: people, person rename @ravi "Ravi Kumar", person merge @rav @ravi');
  },
};

async function listPeople(k: Store): Promise<Block[]> {
  const people = (await k.listPeople()).filter((x) => !isSelf(x.handle));
  if (people.length === 0) return [hint('No people yet. They appear when you use @name in owe or wait.'), data({ people: [] })];
  const open = await k.db
    .select({ personId: t.commitments.personId, direction: t.commitments.direction })
    .from(t.commitments)
    .where(and(eq(t.commitments.status, 'open'), isNull(t.commitments.deletedAt)));
  const count = (id: string, direction: 'owe' | 'wait') => open.filter((c) => c.personId === id && c.direction === direction).length;
  return [
    heading(`PEOPLE · ${people.length}`),
    table(
      people.map((x) => [
        s(`@${x.handle}`, 'accent'),
        s(x.name),
        s(`you owe ${count(x.id, 'owe')} · waiting on ${count(x.id, 'wait')}`, 'muted'),
      ]),
    ),
    data({ people: people.map((x) => ({ handle: x.handle, name: x.name, owe: count(x.id, 'owe'), wait: count(x.id, 'wait') })) }),
  ];
}

