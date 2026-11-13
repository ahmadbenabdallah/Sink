import type { McpLevel } from './auth'

/**
 * Usage of the MCP endpoint by one caller. Both values are `null` when usage
 * could not be read, which is different from zero. `lastUsedAt` alone is `null`
 * for a caller that has never made a call.
 */
export interface ConnectorUsage {
  /** Unix seconds of the caller's most recent tool call. */
  lastUsedAt: number | null
  /** Tool calls in the last seven days. */
  calls7d: number | null
}

/** A connector as the dashboard and the API see it: never its token, never its hash. */
export interface ConnectorView extends ConnectorUsage {
  id: string
  name: string
  /** The first characters of the token after its prefix, to tell connectors apart. */
  hint: string
  level: McpLevel
  /** Unix seconds. */
  createdAt: number
  /** Unix seconds, or `null` while the connector is active. */
  revokedAt: number | null
}

/** A caller of the MCP endpoint that is not a connector: the site token unless it is refused there, and Cloudflare Access when it is configured. */
export interface ReservedCallerView extends ConnectorUsage {
  id: 'site-token' | 'access'
}

export interface ConnectorListResponse {
  /** Newest first, revoked ones included. */
  connectors: ConnectorView[]
  reserved: ReservedCallerView[]
  /** Tool calls each caller may make per UTC day. */
  dailyCallLimit: number
}

export interface ConnectorCreateResponse {
  connector: ConnectorView
  /** The token itself. This answer is the only place it ever appears. */
  token: string
}

export interface ConnectorRevokeResponse {
  id: string
  revokedAt: number
}
