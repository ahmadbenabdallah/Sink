export type AuthMethod = 'site-token' | 'access-user' | 'access-service' | 'connector'

/**
 * What a caller may do on the MCP endpoint. Each level includes the one before:
 * `read` reads links and analytics, `create` also creates links, `full` also
 * changes and deletes them and can check their targets.
 */
export type McpLevel = 'read' | 'create' | 'full'

/** Who sent an MCP request. The tool list, and later usage and logs, are decided from this record alone. */
export interface McpCaller {
  kind: 'site-token' | 'access' | 'connector'
  /** The connector's id, or the fixed ids `site-token` and `access`. */
  id: string
  name: string
  level: McpLevel
}

export interface VerifyResponse {
  name: string
  url: string
  authMethod: AuthMethod
  userID: string
  userEmail: string
  accessEnabled: boolean
}
