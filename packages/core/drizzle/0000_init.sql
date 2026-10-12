CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_slug` ON `clients` (`slug`);--> statement-breakpoint
CREATE TABLE `commitments` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`ref_no` integer NOT NULL,
	`direction` text NOT NULL,
	`title` text NOT NULL,
	`person_id` text NOT NULL,
	`project_id` text,
	`due_on` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`source` text DEFAULT 'other' NOT NULL,
	`source_ref` text,
	`tags` text,
	`renegotiated_count` integer DEFAULT 0 NOT NULL,
	`last_nudged_at` text,
	`notes` text,
	`closed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commitments_ref` ON `commitments` (`ref_no`);--> statement-breakpoint
CREATE INDEX `commitments_open` ON `commitments` (`status`,`due_on`);--> statement-breakpoint
CREATE TABLE `context_log` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`project_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text
);
--> statement-breakpoint
CREATE INDEX `context_log_open` ON `context_log` (`ended_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text
);
--> statement-breakpoint
CREATE INDEX `events_entity` ON `events` (`entity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `focus` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`date` text NOT NULL,
	`slot` integer NOT NULL,
	`commitment_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `focus_date_slot` ON `focus` (`date`,`slot`);--> statement-breakpoint
CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`ref_no` integer NOT NULL,
	`text` text NOT NULL,
	`project_id` text,
	`source` text DEFAULT 'other' NOT NULL,
	`triaged_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_ref` ON `inbox_items` (`ref_no`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`client_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_handle` ON `people` (`handle`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`ref_no` integer NOT NULL,
	`client_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_touched_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_ref` ON `projects` (`ref_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_client_slug` ON `projects` (`client_id`,`slug`);--> statement-breakpoint
CREATE TABLE `resume_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`project_id` text NOT NULL,
	`where_i_am` text,
	`next_step` text,
	`unsure_about` text
);
--> statement-breakpoint
CREATE INDEX `resume_notes_project` ON `resume_notes` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` text NOT NULL
);
