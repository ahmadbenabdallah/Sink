import { timingSafeEqual } from 'node:crypto'

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

  const token = getHeader(event, 'Authorization')?.replace(/^Bearer\s+/, '')
  if (await verifySiteToken(token, useRuntimeConfig(event).siteToken)) {
    event.context.authMethod = 'site-token'
    event.context.userID = 'root'
    event.context.userEmail = `root@${getRequestURL(event).hostname}`
    return
  }

  const accessIdentity = await verifyCloudflareAccess(event)
  if (accessIdentity) {
    if (isCloudflareAccessRequestAllowed(event)) {
      Object.assign(
        event.context,
        mapCloudflareAccessIdentity(accessIdentity, getRequestURL(event).hostname),
      )
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

async function verifySiteToken(provided: string | undefined, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided || '')),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  return timingSafeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash))
}
