CREATE TABLE `auth_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`window_start` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`auth_version` integer NOT NULL,
	`requires_change` integer DEFAULT 0 NOT NULL,
	`kind` text NOT NULL,
	`platform_user_id` text,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`designer` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`password_hash` text,
	`temporary_hash` text,
	`temporary_expires` text,
	`auth_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`last_login_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_users_email_unique` ON `auth_users` (`email`);