import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { McpLevel } from '#shared/types/auth'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { customAlphabet } from 'nanoid'
import { mcpTokens } from '../../database/schema'
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
}

const connectorColumns = {
  id: mcpTokens.id,
  name: mcpTokens.name,
  hint: mcpTokens.hint,
  level: mcpTokens.level,
  createdAt: mcpTokens.createdAt,
  revokedAt: mcpTokens.revokedAt,
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
    hint: token.slice(MCP_TOKEN_PREFIX.length, MCP_TOKEN_PREFIX.length + HINT_LENGTH),
    level: input.level,
    createdAt: Math.floor(Date.now() / 1000),
    revokedAt: null,
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
      .where(and(eq(mcpTokens.tokenHash, await hashToken(token)), isNull(mcpTokens.revokedAt)))
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
    // The driver's own message holds the query and with it the token hash, so
    // only the underlying cause is logged. That is where "no such table" is,
    // which is what a deployment without the migration looks like.
    const cause = (error as { cause?: { message?: unknown } } | null)?.cause?.message
    console.error({
      event: 'mcp_token.lookup_failed',
      errorName: error instanceof Error ? error.name : typeof error,
      cause: typeof cause === 'string' ? cause.slice(0, 300) : undefined,
    })
    return null
  }
}

/** Revokes a token. Revoking it again changes nothing. Resolves to nothing when the id is unknown. */
export async function revokeToken(db: DrizzleD1Database, id: string): Promise<Connector | null> {
  await db
    .update(mcpTokens)
    .set({ revokedAt: Math.floor(Date.now() / 1000) })
    .where(and(eq(mcpTokens.id, id), isNull(mcpTokens.revokedAt)))
  const [connector] = await db.select(connectorColumns).from(mcpTokens).where(eq(mcpTokens.id, id)).limit(1)
  return connector ?? null
}

/**
 * Every token, revoked ones included, newest first. Creation times are whole
 * seconds, so tokens made in the same second are ordered by insertion: rows
 * are never deleted, which makes the row id the order they were added in.
 */
export async function listTokens(db: DrizzleD1Database): Promise<Connector[]> {
  return await db.select(connectorColumns).from(mcpTokens).orderBy(desc(mcpTokens.createdAt), sql`rowid desc`)
}
