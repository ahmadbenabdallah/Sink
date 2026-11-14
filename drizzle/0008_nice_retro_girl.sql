CREATE TABLE `analytics_export_steps` (
	`day` text NOT NULL,
	`step` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`parked_at` integer,
	PRIMARY KEY(`day`, `step`)
);
--> statement-breakpoint
CREATE INDEX `analytics_export_steps_pending_idx` ON `analytics_export_steps` (`completed_at`,`parked_at`,`day`,`step`);