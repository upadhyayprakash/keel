ALTER TABLE `goal_steps` ADD `cue_pushed_for` text;--> statement-breakpoint
ALTER TABLE `goal_steps` ADD `missed_cue_at` text;--> statement-breakpoint
ALTER TABLE `goals` ADD `missed_in_a_row` integer DEFAULT 0 NOT NULL;