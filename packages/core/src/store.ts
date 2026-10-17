import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { ulid } from 'ulidx';
import type { Tone } from './blocks';
import { ymd } from './dates';
import { isConnectionError, isConstraintError, type Db } from './db/client';
import * as t from './db/schema';
import { Conflict, KeelError } from './errors';
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
export const OFFLINE = new KeelError("You're offline, so this wasn't saved.", "Reading still works from this device's copy. Try again when you're back online.");

/**
 * For a synced copy: writes go straight to the hosted database in one request,
 * then the local copy catches up. Writing through the copy instead sends each
 * statement separately (about 4 seconds per change from Asia to Europe, versus 1).
 */
export interface Writer {
  db: Db;
  sync(): Promise<void>;
}

/** The write_guard CHECK failed: a guarded update matched no row. */
function isGuardFailure(e: unknown): boolean {
  const text = `${e instanceof Error ? e.message : String(e)} ${(e as { cause?: unknown })?.cause ?? ''}`;
  return /CHECK constraint failed/i.test(text) && /write_guard/i.test(text);
}

export class Store {
  constructor(
    public db: Db,
    public now: () => Date,
    /** Synced, but the hosted database couldn't be reached when Keel opened: reads only. */
    public offline = false,
    private writer: Writer | null = null,
  ) {}

  /** Guard statements made by guarded(), so batch() can clean up after them and report a conflict. */
  private guards = new WeakSet<object>();

  newId = () => ulid();
  iso = () => this.now().toISOString();
  today = () => ymd(this.now());
  stamps() {
    const at = this.iso();
    return { createdAt: at, updatedAt: at };
  }

  /**
   * ADR 0003: an update that must find the row as the command saw it. `update` carries
   * the guard in its WHERE clause (`status = 'open'`); when it changes no rows, the
   * statement after it fails a CHECK and batch() rolls everything back with a Conflict.
   */
  guarded(update: Query): Query[] {
    const check = this.db.run(sql`insert into write_guard (ok) values (changes())`);
    this.guards.add(check);
    return [update, check];
  }

  async batch(queries: Query[]): Promise<void> {
    if (queries.length === 0) return;
    if (this.offline) throw OFFLINE;
    const target = this.writer?.db ?? this.db;
    const hasGuard = queries.some((q) => typeof q === 'object' && q !== null && this.guards.has(q));
    // The guard rows only exist inside the batch.
    const all = hasGuard ? [...queries, this.db.delete(t.writeGuard)] : queries;
    const send = () => target.batch(all as [Query, ...Query[]]);
    try {
      await send();
    } catch (e) {
      if (hasGuard && isGuardFailure(e)) throw new Conflict();
      if (!isConnectionError(e)) throw e;
      if (!this.writer) throw OFFLINE;
      // Hosted connections get dropped when idle; try once more. Safe: every row's id is
      // set before sending, so if the first attempt did land, this one fails on that id.
      try {
        await send();
      } catch (again) {
        if (isConnectionError(again)) throw OFFLINE;
        // A failed id or guard constraint here means the first attempt landed.
        if (!isConstraintError(again)) throw again;
      }
    }
    if (this.writer) await this.catchUp();
  }

  /** After a write, the local copy must see it before the command reads it back. */
  private async catchUp(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.writer!.sync();
      } catch (e) {
        if (!isConnectionError(e)) throw e;
      }
    }
    throw new KeelError("Saved, but this device's copy couldn't catch up yet.", 'Run the command again in a moment to see it.');
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

  async nextRef(table: typeof t.commitments | typeof t.inboxItems | typeof t.projects | typeof t.goals): Promise<number> {
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
