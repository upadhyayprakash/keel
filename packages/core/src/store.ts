import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { ulid } from 'ulidx';
import type { Tone } from './blocks';
import { ymd } from './dates';
import type { Db } from './db/client';
import * as t from './db/schema';
import { KeelError } from './errors';
import type { Parsed } from './parse';

export type Client = typeof t.clients.$inferSelect;
export type Project = typeof t.projects.$inferSelect;
export type Commitment = typeof t.commitments.$inferSelect;
export type InboxItem = typeof t.inboxItems.$inferSelect;
export type ResumeNote = typeof t.resumeNotes.$inferSelect;

export interface ProjectView {
  project: Project;
  client: Client;
  path: string;
  hue: Tone;
}

export interface CommitmentView {
  c: Commitment;
  person: string;
  personName: string;
  project: string | null;
  projectRef: number | null;
  hue: Tone | null;
}

// Drizzle's batch() wants a non-empty tuple of queries; this keeps call sites simple.
type Query = any;

/** Data access for commands. Every call is async and writes go through batch() (Turso-ready rules 3 and 4). */
export class Store {
  constructor(
    public db: Db,
    public now: () => Date,
  ) {}

  newId = () => ulid();
  iso = () => this.now().toISOString();
  today = () => ymd(this.now());
  stamps() {
    const at = this.iso();
    return { createdAt: at, updatedAt: at };
  }

  async batch(queries: Query[]): Promise<void> {
    if (queries.length === 0) return;
    await this.db.batch(queries as [Query, ...Query[]]);
  }

  // ---- settings ----

  async getSetting(key: string): Promise<string | null> {
    const rows = await this.db.select().from(t.settings).where(eq(t.settings.key, key));
    return rows[0]?.value ?? null;
  }

  setSetting(key: string, value: string | null): Query {
    const updatedAt = this.iso();
    return this.db
      .insert(t.settings)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: t.settings.key, set: { value, updatedAt } });
  }

  // ---- refs and events ----

  async nextRef(table: typeof t.commitments | typeof t.inboxItems | typeof t.projects): Promise<number> {
    const rows = await this.db
      .select({ m: sql<number>`coalesce(max(${table.refNo}), 0)` })
      .from(table as typeof t.commitments);
    return Number(rows[0]?.m ?? 0) + 1;
  }

  event(entity: string, entityId: string, kind: string, payload?: unknown): Query {
    return this.db.insert(t.events).values({
      id: this.newId(),
      ...this.stamps(),
      entity,
      entityId,
      kind,
      payloadJson: payload === undefined ? null : JSON.stringify(payload),
    });
  }

  async eventsFor(entityId: string, limit = 10) {
    return this.db
      .select()
      .from(t.events)
      .where(eq(t.events.entityId, entityId))
      .orderBy(desc(t.events.createdAt))
      .limit(limit);
  }

  // ---- clients and projects ----

  /** Like clientBySlug, but a missing client is an error. */
  async requireClient(slug: string | undefined, usage: string): Promise<Client> {
    if (!slug) throw new KeelError('Which client?', usage);
    const found = await this.clientBySlug(slug.replace(/^\+/, '').toLowerCase());
    if (!found) throw new KeelError(`No client ${slug}.`, 'List them with: clients --all');
    return found;
  }

  async personByHandle(handle: string) {
    const rows = await this.db
      .select()
      .from(t.people)
      .where(and(eq(t.people.handle, handle.replace(/^@/, '').toLowerCase()), isNull(t.people.deletedAt)));
    if (!rows[0]) throw new KeelError(`No person @${handle.replace(/^@/, '')}.`, 'List them with: people');
    return rows[0];
  }

  async clientBySlug(slug: string): Promise<Client | null> {
    const rows = await this.db
      .select()
      .from(t.clients)
      .where(and(eq(t.clients.slug, slug), isNull(t.clients.deletedAt)));
    return rows[0] ?? null;
  }

  /** Archived clients (and their projects) are hidden unless asked for. */
  async listClients(includeArchived = false): Promise<Client[]> {
    return this.db
      .select()
      .from(t.clients)
      .where(and(isNull(t.clients.deletedAt), includeArchived ? undefined : isNull(t.clients.archivedAt)))
      .orderBy(asc(t.clients.slug));
  }

  private async projectViews(where: SQL[], includeArchived = false): Promise<ProjectView[]> {
    const rows = await this.db
      .select({ project: t.projects, client: t.clients })
      .from(t.projects)
      .innerJoin(t.clients, eq(t.projects.clientId, t.clients.id))
      .where(and(isNull(t.projects.deletedAt), isNull(t.clients.deletedAt), includeArchived ? undefined : isNull(t.clients.archivedAt), ...where))
      .orderBy(asc(t.clients.slug), asc(t.projects.slug));
    return rows.map((r) => ({
      ...r,
      path: `${r.client.slug}/${r.project.slug}`,
      hue: r.client.color as Tone,
    }));
  }

  listProjects(includeArchived = false): Promise<ProjectView[]> {
    return this.projectViews([], includeArchived);
  }

  async projectById(id: string): Promise<ProjectView | null> {
    return (await this.projectViews([eq(t.projects.id, id)]))[0] ?? null;
  }

  async projectByRef(n: number): Promise<ProjectView | null> {
    return (await this.projectViews([eq(t.projects.refNo, n)]))[0] ?? null;
  }

  async projectByPath(path: string): Promise<ProjectView> {
    const [clientSlug, projectSlug] = path.toLowerCase().split('/');
    if (!clientSlug || !projectSlug) {
      throw new KeelError(`"${path}" is a client, not a project.`, 'Use client/project, for example acme/website.');
    }
    const found = await this.projectViews([eq(t.clients.slug, clientSlug), eq(t.projects.slug, projectSlug)], true);
    if (!found[0]) {
      throw new KeelError(`No project ${clientSlug}/${projectSlug}.`, `Create it: project new ${clientSlug}/${projectSlug} "Name"`);
    }
    if (found[0].client.archivedAt) {
      throw new KeelError(`${clientSlug} is archived.`, `Bring it back first: client unarchive ${clientSlug}`);
    }
    return found[0];
  }

  async contextProject(): Promise<ProjectView | null> {
    const id = await this.getSetting('context');
    return id ? this.projectById(id) : null;
  }

  /** The project named with +client/project, or the current context. */
  async projectFromArgs(p: Parsed): Promise<ProjectView | null> {
    const path = p.projects[0];
    if (path) return this.projectByPath(path);
    return this.contextProject();
  }

  async latestResumeNote(projectId: string): Promise<ResumeNote | null> {
    const rows = await this.db
      .select()
      .from(t.resumeNotes)
      .where(and(eq(t.resumeNotes.projectId, projectId), isNull(t.resumeNotes.deletedAt)))
      .orderBy(desc(t.resumeNotes.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async openContextLog() {
    const rows = await this.db.select().from(t.contextLog).where(isNull(t.contextLog.endedAt)).limit(1);
    return rows[0] ?? null;
  }

  // ---- people ----

  /** Finds a person by handle, or prepares the insert that creates them. */
  async person(handle: string): Promise<{ id: string; name: string; queries: Query[] }> {
    const rows = await this.db.select().from(t.people).where(eq(t.people.handle, handle));
    if (rows[0]) return { id: rows[0].id, name: rows[0].name, queries: [] };
    const id = this.newId();
    const name = handle.charAt(0).toUpperCase() + handle.slice(1);
    return { id, name, queries: [this.db.insert(t.people).values({ id, ...this.stamps(), handle, name })] };
  }

  async listPeople() {
    return this.db.select().from(t.people).where(isNull(t.people.deletedAt)).orderBy(asc(t.people.handle));
  }

  // ---- commitments ----

  async commitmentViews(where: SQL[] = []): Promise<CommitmentView[]> {
    const rows = await this.db
      .select({
        c: t.commitments,
        person: t.people.handle,
        personName: t.people.name,
        projectSlug: t.projects.slug,
        projectRef: t.projects.refNo,
        clientSlug: t.clients.slug,
        hue: t.clients.color,
      })
      .from(t.commitments)
      .innerJoin(t.people, eq(t.commitments.personId, t.people.id))
      .leftJoin(t.projects, eq(t.commitments.projectId, t.projects.id))
      .leftJoin(t.clients, eq(t.projects.clientId, t.clients.id))
      .where(and(isNull(t.commitments.deletedAt), ...where))
      .orderBy(asc(t.commitments.dueOn), asc(t.commitments.refNo));
    return rows.map((r) => ({
      c: r.c,
      person: r.person,
      personName: r.personName,
      project: r.clientSlug && r.projectSlug ? `${r.clientSlug}/${r.projectSlug}` : null,
      projectRef: r.projectRef ?? null,
      hue: (r.hue as Tone | null) ?? null,
    }));
  }

  async commitmentByRef(n: number): Promise<CommitmentView> {
    const found = (await this.commitmentViews([eq(t.commitments.refNo, n)]))[0];
    if (!found) throw new KeelError(`No commitment c${n}.`, 'List them with: ls');
    return found;
  }

  // ---- inbox ----

  async inboxByRef(n: number): Promise<InboxItem> {
    const rows = await this.db
      .select()
      .from(t.inboxItems)
      .where(and(eq(t.inboxItems.refNo, n), isNull(t.inboxItems.deletedAt)));
    if (!rows[0]) throw new KeelError(`No inbox item i${n}.`, 'List them with: ls inbox');
    return rows[0];
  }

  async openInbox(): Promise<InboxItem[]> {
    return this.db
      .select()
      .from(t.inboxItems)
      .where(and(isNull(t.inboxItems.deletedAt), isNull(t.inboxItems.triagedAt)))
      .orderBy(asc(t.inboxItems.refNo));
  }

  // ---- focus ----

  async focusFor(date: string) {
    return this.db
      .select()
      .from(t.focus)
      .where(and(eq(t.focus.date, date), isNull(t.focus.deletedAt)))
      .orderBy(asc(t.focus.slot));
  }
}
