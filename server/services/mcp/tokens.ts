import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { McpLevel } from '#shared/types/auth'
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { customAlphabet } from 'nanoid'
import { mcpTokens } from '../../database/schema'
import { describeFailure } from './failure'
import { isMcpLevel } from './levels'

/**
 * Connector tokens: named credentials for one agent connection each, valid on
 * the MCP endpoint only. A token is 32 random bytes behind a fixed prefix. Only
 * its SHA-256 is stored, so the value exists once, in the answer to the request
 * that created it.
 *
 * A plain hash, not a salted password hash, on purpose: the token has 256 bits
 * of entropy, so there is nothing to brute-force, and a salted hash could not be
 * looked up by value.
 *
 * Every function takes the database handle, not the request, so tests and the
 * routes use the same code.
 */

export const MCP_TOKEN_PREFIX = 'sink_mcp_'
/** The prefix and 32 bytes in base64url. Anything else is not a token and is never looked up. */
const TOKEN_PATTERN = /^sink_mcp_[\w-]{43}$/
const HINT_LENGTH = 6

// The same unambiguous alphabet link ids use. Declared here because the link
// schema module that holds the other copy needs Nuxt's runtime config to load.
const newId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 10)

/** What the rest of the application may know about a token: everything but its hash. */
export interface Connector {
  id: string
  name: string
  /** The first characters after the prefix, to tell tokens apart in a list. */
  hint: string
  level: McpLevel
  createdAt: number
  revokedAt: number | null
  rotatedAt: number | null
}

const connectorColumns = {
  id: mcpTokens.id,
  name: mcpTokens.name,
  hint: mcpTokens.hint,
  level: mcpTokens.level,
  createdAt: mcpTokens.createdAt,
  revokedAt: mcpTokens.revokedAt,
  rotatedAt: mcpTokens.rotatedAt,
}

/** Rows the app may still see: removed ones are hidden for good. */
const notRemoved = isNull(mcpTokens.removedAt)
/** Rows that may still change: neither revoked nor removed. */
const active = and(isNull(mcpTokens.revokedAt), notRemoved)

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function tokenHint(token: string): string {
  return token.slice(MCP_TOKEN_PREFIX.length, MCP_TOKEN_PREFIX.length + HINT_LENGTH)
}

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const base64 = btoa(String.fromCharCode(...bytes))
  return MCP_TOKEN_PREFIX + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Creates a token and returns its value. This is the only time the value is available. */
export async function createToken(db: DrizzleD1Database, input: { name: string, level: McpLevel }): Promise<{ connector: Connector, token: string }> {
  const token = generateToken()
  const connector: Connector = {
    id: newId(),
    name: input.name,
    hint: tokenHint(token),
    level: input.level,
    createdAt: nowSeconds(),
    revokedAt: null,
    rotatedAt: null,
  }
  await db.insert(mcpTokens).values({ ...connector, tokenHash: await hashToken(token) })
  return { connector, token }
}

/**
 * Resolves a presented token to the connector it belongs to, or to nothing.
 *
 * Nothing is the answer for a revoked token, for a stored level this code does
 * not know, and for any database failure, including the table not existing
 * yet: a caller must be refused, never shown an error, and the site token does
 * not depend on this lookup.
 */
export async function findActiveToken(db: DrizzleD1Database, token: string): Promise<Pick<Connector, 'id' | 'name' | 'level'> | null> {
  if (!TOKEN_PATTERN.test(token))
    return null

  try {
    const [connector] = await db
      .select({ id: mcpTokens.id, name: mcpTokens.name, level: mcpTokens.level })
      .from(mcpTokens)
      // Removed rows too, not only revoked ones: remove always revokes, but a
      // hand-run query must not leave a working token that no page can see.
      .where(and(eq(mcpTokens.tokenHash, await hashToken(token)), active))
      .limit(1)
    if (!connector)
      return null
    if (!isMcpLevel(connector.level)) {
      console.error({ event: 'mcp_token.unknown_level', id: connector.id })
      return null
    }
    return connector
  }
  catch (error) {
    // Never the error itself: for a failed query its message holds the token
    // hash. The description carries the cause, which is where "no such table"
    // is when a deployment has not run the migration.
    console.error({ event: 'mcp_token.lookup_failed', ...describeFailure(error) })
    return null
  }
}

/**
 * Which way a change that matched no row went: the connector is revoked (it
 * can only be removed), or there is none to change (unknown, or removed).
 * Never returns the token or its hash.
 */
export async function connectorState(db: DrizzleD1Database, id: string): Promise<'active' | 'revoked' | 'missing'> {
  const [row] = await db.select({ revokedAt: mcpTokens.revokedAt }).from(mcpTokens).where(and(eq(mcpTokens.id, id), notRemoved)).limit(1)
  if (!row)
    return 'missing'
  return row.revokedAt === null ? 'active' : 'revoked'
}

/**
 * Revokes a token with one guarded update. Revoking it again changes nothing
 * and returns the stored revocation. Resolves to nothing when the id is
 * unknown or the connector was removed.
 */
export async function revokeToken(db: DrizzleD1Database, id: string): Promise<Connector | null> {
  const [revoked] = await db.update(mcpTokens).set({ revokedAt: nowSeconds() }).where(and(eq(mcpTokens.id, id), active)).returning(connectorColumns)
  if (revoked)
    return revoked
  const [stored] = await db.select(connectorColumns).from(mcpTokens).where(and(eq(mcpTokens.id, id), notRemoved, isNotNull(mcpTokens.revokedAt))).limit(1)
  return stored ?? null
}

/** Renames an active connector. Resolves to nothing when none matched: see `connectorState`. */
export async function renameToken(db: DrizzleD1Database, id: string, name: string): Promise<Connector | null> {
  const [renamed] = await db.update(mcpTokens).set({ name }).where(and(eq(mcpTokens.id, id), active)).returning(connectorColumns)
  return renamed ?? null
}

/**
 * Replaces an active connector's token: the old one is refused from the next
 * request on. The id, name, level and usage history stay. Returns the new
 * token, available only here, or nothing when none matched.
 */
export async function rotateToken(db: DrizzleD1Database, id: string): Promise<{ connector: Connector, token: string } | null> {
  const token = generateToken()
  const [connector] = await db.update(mcpTokens)
    .set({ tokenHash: await hashToken(token), hint: tokenHint(token), rotatedAt: nowSeconds() })
    .where(and(eq(mcpTokens.id, id), active))
    .returning(connectorColumns)
  return connector ? { connector, token } : null
}

/**
 * Removes a connector, active or revoked: it is revoked if it was not, and
 * hidden from the app for good. The row stays, so the logs and usage history
 * still name it. Resolves to nothing when there is none to remove.
 */
export async function removeToken(db: DrizzleD1Database, id: string): Promise<{ id: string, removedAt: number } | null> {
  const now = nowSeconds()
  const [removed] = await db.update(mcpTokens)
    .set({ revokedAt: sql`coalesce(${mcpTokens.revokedAt}, ${now})`, removedAt: now })
    .where(and(eq(mcpTokens.id, id), notRemoved))
    .returning({ id: mcpTokens.id })
  return removed ? { id: removed.id, removedAt: now } : null
}

/**
 * Every token not removed, revoked ones included, newest first. Creation times
 * are whole seconds, so tokens made in the same second are ordered by
 * insertion: rows are never deleted, which makes the row id the order they
 * were added in.
 */
export async function listTokens(db: DrizzleD1Database): Promise<Connector[]> {
  return await db.select(connectorColumns).from(mcpTokens).where(notRemoved).orderBy(desc(mcpTokens.createdAt), sql`rowid desc`)
}
