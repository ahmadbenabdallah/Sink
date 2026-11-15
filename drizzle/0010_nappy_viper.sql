CREATE TABLE `deleted_link_ids` (
	`id` text PRIMARY KEY NOT NULL,
	`deleted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deleted_link_ids_deleted_at_idx` ON `deleted_link_ids` (`deleted_at`);