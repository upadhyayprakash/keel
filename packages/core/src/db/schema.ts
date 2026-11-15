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
    /** The shelf lists land on when no project is named (ADR 0005). Found by this flag, never by name. */
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    uniqueIndex('projects_ref').on(t.refNo),
    uniqueIndex('projects_client_slug').on(t.clientId, t.slug),
    // At most one default project per client (ADR 0005); two devices making it at once cannot both win.
    uniqueIndex('projects_one_default').on(t.clientId).where(sql`${t.isDefault} = 1 and ${t.deletedAt} is null`),
  ],
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
    /** Cues missed since a step was last done; 2 or more is flagged ("never miss twice"). */
    missedInARow: integer('missed_in_a_row').notNull().default(0),
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
    /** The `cueAt` a reminder went out for; a new cue time gets its own reminder. */
    cuePushedFor: text('cue_pushed_for'),
    /** The `cueAt` that was missed: the step was still open when that day ended. */
    missedCueAt: text('missed_cue_at'),
  },
  (t) => [index('goal_steps_goal').on(t.goalId, t.position), index('goal_steps_cue').on(t.status, t.cueAt)],
);

/** The review written when a goal closes (ADR 0004). Planned and took days pad the next goal's deadline. */
export const goalReviews = sqliteTable(
  'goal_reviews',
  {
    ...base(),
    goalId: text('goal_id').notNull(),
    outcome: text('outcome', { enum: ['done', 'dropped'] }).notNull(),
    /** Days from the goal's start to its deadline, and to the day it closed. */
    plannedDays: integer('planned_days').notNull(),
    tookDays: integer('took_days').notNull(),
    /** The three questions: what happened against the plan, why, what to change next time. */
    happened: text('happened'),
    why: text('why'),
    change: text('change'),
  },
  (t) => [index('goal_reviews_goal').on(t.goalId), index('goal_reviews_outcome').on(t.outcome, t.createdAt)],
);

/** Lists (ADR 0005): a plain collection or a tracked checklist, always under a project. */
export const lists = sqliteTable(
  'lists',
  {
    ...base(),
    refNo: integer('ref_no').notNull(),
    projectId: text('project_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** A few tags or topics, space separated, like `commitments.tags`. */
    tags: text('tags'),
    /** `tracked` shows item states and "4 of 7 done"; `plain` shows the items alone. */
    kind: text('kind', { enum: ['plain', 'tracked'] }).notNull().default('plain'),
    /** How the items are shown. Never rewrites the stored `position`s. */
    viewSort: text('view_sort', { enum: ['manual', 'state', 'created', 'alpha'] }).notNull().default('manual'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    /** Null: no cover set, so the built-in placeholder is shown. */
    coverKind: text('cover_kind', { enum: ['svg', 'png'] }),
    /** SVG source, or base64 of a PNG. At most 200 KB. */
    cover: text('cover'),
    /** Optional dark-theme version; without it `cover` is used in both themes. */
    coverDark: text('cover_dark'),
    resetCount: integer('reset_count').notNull().default(0),
    lastResetAt: text('last_reset_at'),
  },
  (t) => [uniqueIndex('lists_ref').on(t.refNo), index('lists_project').on(t.projectId, t.status)],
);

export const listItems = sqliteTable(
  'list_items',
  {
    ...base(),
    listId: text('list_id').notNull(),
    /** A fractional key (ADR 0005): sorts as text, and a drag writes only the dragged row. */
    position: text('position').notNull(),
    text: text('text').notNull(),
    note: text('note'),
    state: text('state', { enum: ['open', 'doing', 'blocked', 'done'] }).notNull().default('open'),
    doneAt: text('done_at'),
  },
  (t) => [index('list_items_list').on(t.listId, t.position)],
);

/** A phone or browser that turned on Goals reminders (ADR 0004): where web push sends, and its keys. */
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    ...base(),
    /** The browser push service's URL for this device. */
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** The VAPID public key the device subscribed with; a server with other keys cannot send to it. */
    serverKey: text('server_key').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (t) => [uniqueIndex('push_subscriptions_endpoint').on(t.endpoint)],
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
