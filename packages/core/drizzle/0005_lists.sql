CREATE TABLE `list_items` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`list_id` text NOT NULL,
	`position` text NOT NULL,
	`text` text NOT NULL,
	`note` text,
	`state` text DEFAULT 'open' NOT NULL,
	`done_at` text
);
--> statement-breakpoint
CREATE INDEX `list_items_list` ON `list_items` (`list_id`,`position`);--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`ref_no` integer NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`tags` text,
	`kind` text DEFAULT 'plain' NOT NULL,
	`view_sort` text DEFAULT 'manual' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`cover_kind` text,
	`cover` text,
	`cover_dark` text,
	`reset_count` integer DEFAULT 0 NOT NULL,
	`last_reset_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lists_ref` ON `lists` (`ref_no`);--> statement-breakpoint
CREATE INDEX `lists_project` ON `lists` (`project_id`,`status`);--> statement-breakpoint
ALTER TABLE `projects` ADD `is_default` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_one_default` ON `projects` (`client_id`) WHERE "projects"."is_default" = 1 and "projects"."deleted_at" is null;