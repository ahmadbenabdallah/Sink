import type { H3Event } from 'h3'
import type { Compilable } from 'kysely'
import { createError } from 'h3'

export function useWAE(event: H3Event, query: Compilable) {
  const { cfAccountId, cfApiToken } = useRuntimeConfig(event)
  if (!cfAccountId || !cfApiToken)
    return { data: [] }

  const compiledQuery = compileAnalyticsQuery(query)

  if (import.meta.dev)
    console.info('useWAE', compiledQuery)

  // nosemgrep: sink-no-raw-fetch-in-server -- fixed Cloudflare API host, not a user-supplied URL
  return $fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/analytics_engine/sql`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfApiToken}`,
    },
    body: compiledQuery,
    retry: 1,
    retryDelay: 100, // ms
  }).catch((error: { status?: number }) => {
    // Relaying 401/403 would make the dashboard treat a bad Cloudflare token as a bad site token and log out.
    if (error?.status === 401 || error?.status === 403)
      throw createError({ status: 502, statusText: 'Cloudflare API rejected the configured credentials', data: { code: 'cloudflare_credentials_rejected' } })
    // Never relay the upstream status or body: the body can carry the SQL text and the URL the account id.
    console.error({ event: 'cloudflare_api.failed', status: error?.status })
    throw createError({ status: 502, statusText: 'Cloudflare API request failed', data: { code: 'cloudflare_request_failed' } })
  })
}
