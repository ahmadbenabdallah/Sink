import type { Link } from '../../shared/schemas/link'
import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const links = sqliteTable('links', {
  slug: text().primaryKey(),
  id: text().notNull(),
  url: text().notNull(),
  comment: text(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  expiration: integer(),
  title: text(),
  description: text(),
  image: text(),
  apple: text(),
  google: text(),
  cloaking: integer({ mode: 'boolean' }),
  redirectWithQuery: integer('redirect_with_query', { mode: 'boolean' }),
  proxy: integer({ mode: 'boolean' }),
  password: text(),
  unsafe: integer({ mode: 'boolean' }),
  geo: text({ mode: 'json' }).$type<Link['geo']>(),
  normalizedUrl: text('normalized_url').notNull(),
  effectiveExpiresAt: integer('effective_expires_at'),
}, table => [
  index('links_created_at_slug_idx').on(table.createdAt, table.slug),
  index('links_created_at_desc_slug_idx').on(sql`${table.createdAt} desc`, table.slug),
  index('links_normalized_url_idx').on(table.normalizedUrl),
  index('links_id_idx').on(table.id),
])

export const tags = sqliteTable('tags', {
  name: text().primaryKey(),
})

export const linkTags = sqliteTable('link_tags', {
  linkSlug: text('link_slug').notNull().references(() => links.slug, { onDelete: 'cascade' }),
  tagName: text('tag_name').notNull().references(() => tags.name, { onDelete: 'cascade' }),
}, table => [
  primaryKey({ columns: [table.linkSlug, table.tagName] }),
  index('link_tags_tag_name_link_slug_idx').on(table.tagName, table.linkSlug),
])

export const linkTombstones = sqliteTable('link_tombstones', {
  slug: text().primaryKey(),
  deletedAt: integer('deleted_at').notNull(),
})

/**
 * Connector tokens for the MCP endpoint. Only the SHA-256 of a token is kept;
 * `hint` is the first characters after its prefix, shown so tokens can be told
 * apart. A revoked token keeps its row so its name still resolves.
 */
export const mcpTokens = sqliteTable('mcp_tokens', {
  id: text().primaryKey(),
  name: text().notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  hint: text().notNull(),
  level: text({ enum: ['read', 'create', 'full'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  revokedAt: integer('revoked_at'),
}, table => [
  // The level decides which tools a caller gets, so the database refuses a
  // value the code does not know instead of trusting every writer.
  check('mcp_tokens_level_check', sql`${table.level} in ('read', 'create', 'full')`),
])

/**
 * Tool calls on the MCP endpoint, one row per caller per UTC day. `callerId` is
 * a connector's id, or `site-token`, or `access`. It is not a foreign key: the
 * two fixed callers have no row in `mcp_tokens`.
 */
export const mcpUsage = sqliteTable('mcp_usage', {
  callerId: text('caller_id').notNull(),
  day: text().notNull(),
  calls: integer().notNull(),
  lastUsedAt: integer('last_used_at').notNull(),
}, table => [
  primaryKey({ columns: [table.callerId, table.day] }),
])

/**
 * Progress of the analytics archive, one row per step per UTC day. A step is
 * `archive:HH`: copy hour HH of the day from Analytics Engine to R2. A step is
 * pending until `completed_at` is set; `started_at` is a claim that expires
 * after 15 minutes; `parked_at` is set after 3 failed attempts.
 */
export const analyticsExportSteps = sqliteTable('analytics_export_steps', {
  day: text().notNull(),
  step: text().notNull(),
  attempts: integer().notNull().default(0),
  startedAt: integer('started_at'),
  completedAt: integer('completed_at'),
  parkedAt: integer('parked_at'),
}, table => [
  primaryKey({ columns: [table.day, table.step] }),
  index('analytics_export_steps_pending_idx').on(table.completedAt, table.parkedAt, table.day, table.step),
])

export const linkMigrationRuns = sqliteTable('link_migration_runs', {
  id: text().primaryKey(),
  expectedCursor: text('expected_cursor'),
  scanned: integer().notNull().default(0),
  inserted: integer().notNull().default(0),
  skipped: integer().notNull().default(0),
  expired: integer().notNull().default(0),
  force: integer({ mode: 'boolean' }).notNull(),
  status: text({ enum: ['running', 'completed'] }).notNull().default('running'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, table => [
  index('link_migration_runs_status_updated_at_desc_created_at_desc_id_desc_idx').on(
    table.status,
    sql`${table.updatedAt} desc`,
    sql`${table.createdAt} desc`,
    sql`${table.id} desc`,
  ),
])
