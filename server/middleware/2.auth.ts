import type { H3Event } from 'h3'
import { timingSafeEqual } from 'node:crypto'
import { drizzle } from 'drizzle-orm/d1'
import { findActiveToken, MCP_TOKEN_PREFIX } from '../services/mcp/tokens'

/** Window of the `API_AUTH_LIMITER` binding in `wrangler.jsonc`; sent as `Retry-After` when limited. */
const API_AUTH_LIMIT_PERIOD_SECONDS = 60

export default eventHandler(async (event) => {
  if (!event.path.startsWith('/api/'))
    return

  // Counted before any credential is looked at, and for every request. The
  // binding has no way to ask "is this address over the limit" without also
  // counting, so failures cannot be counted on their own: a correct guess
  // would then always pass. This is therefore a ceiling on requests per client
  // address, set well above what the dashboard and an agent send together. It
  // slows guessing of the site token; a long random token is what protects it.
  const limiter = event.context.cloudflare?.env.API_AUTH_LIMITER
  if (!await allowAttempt(limiter, clientBucket(getHeader(event, 'cf-connecting-ip')), 'api_auth.limiter.unavailable')) {
    setResponseHeader(event, 'Retry-After', API_AUTH_LIMIT_PERIOD_SECONDS)
    throw createError({ status: 429, statusText: 'Too many requests', data: { code: 'too_many_requests' } })
  }

  const onMcpRoute = isMcpRoute(event)
  const authorization = getHeader(event, 'Authorization')
  const token = authorization?.replace(/^Bearer\s+/, '')
  const config = useRuntimeConfig(event)

  if (await verifySiteToken(token, config.siteToken)) {
    // The site token is also the dashboard password. An owner whose agents all
    // use connector tokens can stop it being accepted on the MCP endpoint, so a
    // leaked agent config can no longer hold it.
    // This is refused before an Access identity is looked at: the request
    // presented a credential that is switched off here.
    if (onMcpRoute && !isSiteTokenAllowedOnMcp(config.mcpAllowSiteToken)) {
      setResponseHeader(event, 'WWW-Authenticate', 'Bearer')
      throw createError({ status: 401, statusText: 'Site token is not accepted on MCP', data: { code: 'site_token_not_allowed' } })
    }

    event.context.authMethod = 'site-token'
    event.context.userID = 'root'
    event.context.userEmail = `root@${getRequestURL(event).hostname}`
    if (onMcpRoute)
      event.context.mcpCaller = { kind: 'site-token', id: 'site-token', name: 'Site token', level: 'full' }
    return
  }

  // A connector token is a credential for the MCP endpoint and nothing else.
  // It is looked at only for a POST to that route, so on every other route it
  // is an unknown bearer and falls through to the 401 below.
  //
  // It is resolved before an Access identity. Where Access sits in front of
  // the endpoint, an agent's request carries both, and the connector is the
  // narrower identity: the one with a level, a usage count and a revoke
  // button. A connector token that does not resolve is refused outright, so
  // revoking it cuts the agent off whatever else the request carries. A header
  // that holds a connector token written any other way (lower-case scheme,
  // extra spaces, no scheme) is refused too, rather than passed over for an
  // Access identity with every right.
  if (onMcpRoute && event.method === 'POST') {
    if (authorization?.includes(MCP_TOKEN_PREFIX)) {
      const connectorToken = connectorTokenOf(authorization)
      const connector = connectorToken ? await findActiveToken(drizzle(event.context.cloudflare.env.DB), connectorToken) : null
      if (!connector) {
        // Nothing of the token is logged. A refused token is otherwise
        // invisible, and probing with a revoked one should leave a trace.
        console.warn({ event: 'mcp_token.refused' })
        setResponseHeader(event, 'WWW-Authenticate', 'Bearer')
        throw createError({ status: 401, statusText: 'Unauthorized', data: { code: 'unauthorized' } })
      }

      event.context.authMethod = 'connector'
      event.context.userID = connector.id
      event.context.userEmail = `${connector.id}@${getRequestURL(event).hostname}`
      event.context.mcpCaller = { kind: 'connector', ...connector }
      return
    }
  }

  // Without a connector token, an Access identity has every right on every
  // route.
  const accessIdentity = await verifyCloudflareAccess(event)
  if (accessIdentity) {
    if (isCloudflareAccessRequestAllowed(event)) {
      Object.assign(
        event.context,
        mapCloudflareAccessIdentity(accessIdentity, getRequestURL(event).hostname),
      )
      if (onMcpRoute)
        event.context.mcpCaller = { kind: 'access', id: 'access', name: 'Cloudflare Access', level: 'full' }
      return
    }

    throw createError({
      status: 403,
      statusText: 'Forbidden',
      data: { code: 'forbidden' },
    })
  }

  setResponseHeader(event, 'WWW-Authenticate', 'Bearer')

  if (token && token.length < 8) {
    throw createError({
      status: 401,
      statusText: 'Token is too short',
      data: { code: 'token_too_short' },
    })
  }

  throw createError({
    status: 401,
    statusText: 'Unauthorized',
    data: { code: 'unauthorized' },
  })
})

/**
 * Whether the request is for the MCP endpoint. The match is on the path
 * without its query string and allows one trailing slash, which is exactly
 * what the router folds onto the same handler. Anything else, including two
 * trailing slashes or a longer path that starts the same way, is served by
 * something other than the MCP handler and is not the MCP route.
 */
function isMcpRoute(event: H3Event): boolean {
  return /^\/api\/mcp\/?$/.test(event.path.split('?')[0] ?? '')
}

/**
 * The connector token in `Authorization: Bearer sink_mcp_...`, if that is what
 * the header holds. The scheme is required: unlike the site token, a connector
 * token is not accepted bare, and the header must be written exactly this way.
 */
function connectorTokenOf(authorization: string | undefined): string | undefined {
  const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1]
  return token?.startsWith(MCP_TOKEN_PREFIX) ? token : undefined
}

async function verifySiteToken(provided: string | undefined, expected: string): Promise<boolean> {
  // An empty expected token must match nothing. Without this, a deployment
  // whose site token is set to an empty value would take a request with no
  // credentials for the owner, because both sides hash the empty string.
  if (!provided || !expected)
    return false

  const encoder = new TextEncoder()
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  return timingSafeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash))
}
