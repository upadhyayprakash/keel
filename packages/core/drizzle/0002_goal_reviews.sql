CREATE TABLE `goal_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`goal_id` text NOT NULL,
	`outcome` text NOT NULL,
	`planned_days` integer NOT NULL,
	`took_days` integer NOT NULL,
	`happened` text,
	`why` text,
	`change` text
);
--> statement-breakpoint
CREATE INDEX `goal_reviews_goal` ON `goal_reviews` (`goal_id`);--> statement-breakpoint
CREATE INDEX `goal_reviews_outcome` ON `goal_reviews` (`outcome`,`created_at`);