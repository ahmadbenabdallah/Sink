CREATE TABLE `analytics_daily` (
	`day` text NOT NULL,
	`link_id` text NOT NULL,
	`slug` text NOT NULL,
	`visits` integer NOT NULL,
	`visitors` integer NOT NULL,
	`referers` integer NOT NULL,
	PRIMARY KEY(`day`, `link_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `analytics_daily_breakdown` (
	`dimension` text NOT NULL,
	`day` text NOT NULL,
	`link_id` text NOT NULL,
	`value` text NOT NULL,
	`visits` integer NOT NULL,
	`visitors` integer NOT NULL,
	PRIMARY KEY(`dimension`, `day`, `link_id`, `value`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `analytics_export_budget` (
	`utc_day` text PRIMARY KEY NOT NULL,
	`rows_written` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `analytics_export_steps` ADD `next_key` text;