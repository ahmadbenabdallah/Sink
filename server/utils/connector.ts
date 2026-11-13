import type { H3Event } from 'h3'
import type { AuthMethod } from '#shared/types/auth'
import type { ConnectorUsage, ConnectorView } from '#shared/types/connector'
import type { Connector } from '../services/mcp/tokens'
import { drizzle } from 'drizzle-orm/d1'
import { createError, getHeader } from 'h3'

/** The ways of signing in that may manage connectors: the owner's, and nothing else. */
const CONNECTOR_MANAGERS: readonly AuthMethod[] = ['site-token', 'access-user', 'access-service']

/** The database handle the connector routes hand to the token store. */
export function useConnectorDatabase(event: H3Event) {
  return drizzle(event.context.cloudflare.env.DB)
}

/**
 * Whether `NUXT_MCP_ALLOW_SITE_TOKEN` leaves the site token usable on the MCP
 * endpoint. Unset and empty mean yes, which is the default. Otherwise only a
 * value that clearly says yes does: someone who wrote `off` or `0` meant to
 * switch it off, and a typo must not leave the dashboard password accepted.
 */
export function isSiteTokenAllowedOnMcp(value: unknown): boolean {
  if (value === undefined || value === null || value === true || value === 1)
    return true
  return typeof value === 'string' && ['', 'true', '1'].includes(value.trim().toLowerCase())
}

/**
 * Refuses anyone who is not signed in as the owner.
 *
 * The auth middleware already keeps connector tokens off every route but the
 * MCP one. This repeats the rule where it matters most: a connector that could
 * reach these routes could mint connectors of any level. It is an allowlist,
 * so a way of signing in added later is refused until it is listed here.
 */
export function assertConnectorManager(event: H3Event): void {
  if (!CONNECTOR_MANAGERS.includes(event.context.authMethod as AuthMethod))
    throw createError({ status: 403, statusText: 'Forbidden', data: { code: 'forbidden' } })
}

/**
 * Create and revoke take JSON only. A browser sends a form without asking the
 * server first, so accepting one would let a page the owner visits submit it.
 */
export function assertJsonBody(event: H3Event): void {
  if (!(getHeader(event, 'content-type') ?? '').toLowerCase().startsWith('application/json'))
    throw createError({ status: 415, statusText: 'Content-Type must be application/json' })
}

/**
 * A preview instance shares its site token with the public, so anyone could
 * mint or revoke connectors there. Listing stays allowed.
 */
export function assertConnectorChangesAllowed(event: H3Event): void {
  if (useRuntimeConfig(event).public.previewMode) {
    throw createError({
      status: 403,
      statusText: 'Preview mode cannot manage connectors.',
      data: { code: 'preview_mode', action: 'manage connectors' },
    })
  }
}

/** Usage of a caller that has never made a call. */
export const NO_USAGE: ConnectorUsage = { lastUsedAt: null, calls7d: 0 }
/** Usage that could not be read. A client must not show it as zero. */
export const UNKNOWN_USAGE: ConnectorUsage = { lastUsedAt: null, calls7d: null }

/**
 * The connector as the API returns it. The fields are picked one by one, so a
 * column added to the table later is not sent out by accident.
 */
export function toConnectorView(connector: Connector, usage: ConnectorUsage): ConnectorView {
  return {
    id: connector.id,
    name: connector.name,
    hint: connector.hint,
    level: connector.level,
    createdAt: connector.createdAt,
    revokedAt: connector.revokedAt,
    lastUsedAt: usage.lastUsedAt,
    calls7d: usage.calls7d,
  }
}
