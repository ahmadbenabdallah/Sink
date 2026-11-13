import type { ConnectorListResponse } from '#shared/types/connector'
import { describeFailure } from '../../services/mcp/failure'
import { listTokens } from '../../services/mcp/tokens'
import { resolveDailyCallLimit, usageSummary } from '../../services/mcp/usage'

defineRouteMeta({
  openAPI: {
    description: 'List MCP connectors, newest first, revoked ones included. Tokens and their hashes are never returned. Not available to a connector token.',
    security: [{ bearerAuth: [] }],
  },
})

export default eventHandler(async (event): Promise<ConnectorListResponse> => {
  assertConnectorManager(event)
  const { cfAccessTeamDomain, cfAccessAud, mcpDailyCallLimit, mcpAllowSiteToken } = useRuntimeConfig(event)
  const db = useConnectorDatabase(event)
  const connectors = await listTokens(db)

  // The list is still worth showing when usage cannot be read. It is then
  // reported as unknown for everyone, never as zero.
  const usage = await usageSummary(db).catch((error: unknown) => {
    console.error({ event: 'mcp_usage.summary_failed', ...describeFailure(error) })
    return null
  })
  const usageOf = (id: string) => usage ? usage.get(id) ?? NO_USAGE : UNKNOWN_USAGE

  return {
    connectors: connectors.map(connector => toConnectorView(connector, usageOf(connector.id))),
    // Callers of the MCP endpoint that are not connectors: the site token
    // unless it is refused there, and Cloudflare Access where it is configured.
    reserved: [
      ...(isSiteTokenAllowedOnMcp(mcpAllowSiteToken) ? [{ id: 'site-token' as const, ...usageOf('site-token') }] : []),
      ...(isCloudflareAccessConfigured(cfAccessTeamDomain, cfAccessAud) ? [{ id: 'access' as const, ...usageOf('access') }] : []),
    ],
    dailyCallLimit: resolveDailyCallLimit(mcpDailyCallLimit),
  }
})
