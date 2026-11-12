import type { ConnectorListResponse } from '#shared/types/connector'
import { listTokens } from '../../services/mcp/tokens'

defineRouteMeta({
  openAPI: {
    description: 'List MCP connectors, newest first, revoked ones included. Tokens and their hashes are never returned. Not available to a connector token.',
    security: [{ bearerAuth: [] }],
  },
})

export default eventHandler(async (event): Promise<ConnectorListResponse> => {
  assertConnectorManager(event)
  const { cfAccessTeamDomain, cfAccessAud } = useRuntimeConfig(event)
  const connectors = await listTokens(useConnectorDatabase(event))

  return {
    connectors: connectors.map(toConnectorView),
    // Callers of the MCP endpoint that are not connectors. Cloudflare Access is
    // one only where it is configured.
    reserved: [
      { id: 'site-token', lastUsedAt: null, calls7d: null },
      ...(isCloudflareAccessConfigured(cfAccessTeamDomain, cfAccessAud) ? [{ id: 'access' as const, lastUsedAt: null, calls7d: null }] : []),
    ],
  }
})
