CREATE TABLE `project_history` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`before_data` text,
	`after_data` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `name_key` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `archived_by` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `archive_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `created_at` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `updated_at` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `last_change_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_key_unique` ON `projects` (`name_key`);