import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

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

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: text('updated_at').notNull(),
});
