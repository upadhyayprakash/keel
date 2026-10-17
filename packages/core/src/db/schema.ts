import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, uniqueIndex, index, check } from 'drizzle-orm/sqlite-core';

// Turso-ready rules (docs/02-spec.md, section 6): ULID ids, UTC ISO timestamps,
// updated_at on every row, soft deletes, short refs are display-only.

const base = () => ({
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const clients = sqliteTable(
  'clients',
  {
    ...base(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    archivedAt: text('archived_at'),
  },
  (t) => [uniqueIndex('clients_slug').on(t.slug)],
);

export const projects = sqliteTable(
  'projects',
  {
    ...base(),
    refNo: integer('ref_no').notNull(),
    clientId: text('client_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'paused', 'done', 'archived'] }).notNull().default('active'),
    lastTouchedAt: text('last_touched_at'),
  },
  (t) => [uniqueIndex('projects_ref').on(t.refNo), uniqueIndex('projects_client_slug').on(t.clientId, t.slug)],
);

export const resumeNotes = sqliteTable(
  'resume_notes',
  {
    ...base(),
    projectId: text('project_id').notNull(),
    whereIAm: text('where_i_am'),
    nextStep: text('next_step'),
    unsureAbout: text('unsure_about'),
  },
  (t) => [index('resume_notes_project').on(t.projectId, t.createdAt)],
);

export const people = sqliteTable(
  'people',
  {
    ...base(),
    handle: text('handle').notNull(),
    name: text('name').notNull(),
    clientId: text('client_id'),
  },
  (t) => [uniqueIndex('people_handle').on(t.handle)],
);

export const commitments = sqliteTable(
  'commitments',
  {
    ...base(),
    refNo: integer('ref_no').notNull(),
    direction: text('direction', { enum: ['owe', 'wait'] }).notNull(),
    title: text('title').notNull(),
    personId: text('person_id').notNull(),
    projectId: text('project_id'),
    dueOn: text('due_on').notNull(),
    status: text('status', { enum: ['open', 'done', 'dropped'] }).notNull().default('open'),
    source: text('source', { enum: ['meeting', 'slack', 'email', 'claude', 'other'] }).notNull().default('other'),
    sourceRef: text('source_ref'),
    tags: text('tags'),
    renegotiatedCount: integer('renegotiated_count').notNull().default(0),
    lastNudgedAt: text('last_nudged_at'),
    notes: text('notes'),
    closedAt: text('closed_at'),
  },
  (t) => [uniqueIndex('commitments_ref').on(t.refNo), index('commitments_open').on(t.status, t.dueOn)],
);

export const inboxItems = sqliteTable(
  'inbox_items',
  {
    ...base(),
    refNo: integer('ref_no').notNull(),
    text: text('text').notNull(),
    projectId: text('project_id'),
    source: text('source').notNull().default('other'),
    triagedAt: text('triaged_at'),
  },
  (t) => [uniqueIndex('inbox_ref').on(t.refNo)],
);

/** Today's top 3. Row id is `<date>:<slot>`, so setting a slot is an upsert. */
export const focus = sqliteTable(
  'focus',
  {
    ...base(),
    date: text('date').notNull(),
    slot: integer('slot').notNull(),
    commitmentId: text('commitment_id').notNull(),
  },
  (t) => [uniqueIndex('focus_date_slot').on(t.date, t.slot)],
);

export const contextLog = sqliteTable(
  'context_log',
  {
    ...base(),
    projectId: text('project_id').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
  },
  (t) => [index('context_log_open').on(t.endedAt)],
);

export const events = sqliteTable(
  'events',
  {
    ...base(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    kind: text('kind').notNull(),
    payloadJson: text('payload_json'),
  },
  (t) => [index('events_entity').on(t.entityId, t.createdAt)],
);

/** Goals (ADR 0004): one small goal with a finish line, a deadline and an if-then plan. */
export const goals = sqliteTable(
  'goals',
  {
    ...base(),
    refNo: integer('ref_no').notNull(),
    title: text('title').notNull(),
    /** What "done" looks like, in the owner's words. */
    doneMeans: text('done_means').notNull(),
    dueOn: text('due_on').notNull(),
    /** The time budget, in the owner's words ("3 hours a week"). */
    appetite: text('appetite'),
    obstacle: text('obstacle'),
    /** "If <obstacle>, then I will <action>." Required. */
    plan: text('plan').notNull(),
    status: text('status', { enum: ['active', 'done', 'dropped'] }).notNull().default('active'),
    closedAt: text('closed_at'),
  },
  (t) => [uniqueIndex('goals_ref').on(t.refNo), index('goals_active').on(t.status, t.dueOn)],
);

export const goalSteps = sqliteTable(
  'goal_steps',
  {
    ...base(),
    goalId: text('goal_id').notNull(),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    /** When the step is planned, as a local date and time (`2026-10-19T07:00`). */
    cueAt: text('cue_at'),
    cuePlace: text('cue_place'),
    /** The smaller version to offer after a missed cue ("10 minutes"). */
    minimum: text('minimum'),
    firstStep: integer('first_step', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['open', 'done'] }).notNull().default('open'),
    doneAt: text('done_at'),
  },
  (t) => [index('goal_steps_goal').on(t.goalId, t.position), index('goal_steps_cue').on(t.status, t.cueAt)],
);

/**
 * ADR 0003 guarded writes: a guarded update is followed by `INSERT INTO write_guard
 * VALUES (changes())`. When the update matched no row, the CHECK fails and the
 * whole batch rolls back. Rows are deleted again at the end of each batch.
 */
export const writeGuard = sqliteTable('write_guard', { ok: integer('ok').notNull() }, (t) => [check('write_guard_ok', sql`${t.ok} = 1`)]);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: text('updated_at').notNull(),
});
