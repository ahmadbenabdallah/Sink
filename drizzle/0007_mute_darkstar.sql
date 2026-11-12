CREATE TABLE `mcp_usage` (
	`caller_id` text NOT NULL,
	`day` text NOT NULL,
	`calls` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	PRIMARY KEY(`caller_id`, `day`)
);
