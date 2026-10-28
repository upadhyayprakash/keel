CREATE TABLE `goal_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`goal_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`cue_at` text,
	`cue_place` text,
	`minimum` text,
	`first_step` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`done_at` text
);
--> statement-breakpoint
CREATE INDEX `goal_steps_goal` ON `goal_steps` (`goal_id`,`position`);--> statement-breakpoint
CREATE INDEX `goal_steps_cue` ON `goal_steps` (`status`,`cue_at`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`ref_no` integer NOT NULL,
	`title` text NOT NULL,
	`done_means` text NOT NULL,
	`due_on` text NOT NULL,
	`appetite` text,
	`obstacle` text,
	`plan` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goals_ref` ON `goals` (`ref_no`);--> statement-breakpoint
CREATE INDEX `goals_active` ON `goals` (`status`,`due_on`);--> statement-breakpoint
CREATE TABLE `write_guard` (
	`ok` integer NOT NULL,
	CONSTRAINT "write_guard_ok" CHECK("write_guard"."ok" = 1)
);
