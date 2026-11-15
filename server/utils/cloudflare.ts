import type { H3Event } from 'h3'
import type { SelectQueryBuilder } from 'kysely'
import { createError } from 'h3'
import { sql } from 'kysely'
import { hasControlCharacter } from './query-filter'

/** Analytics Engine keeps about three months (89 to 92 days); an id deleted before that has no records left. */
const DELETED_LINK_WINDOW_SECONDS = 92 * 86_400
/**
 * At most this many ids go into one query, the most recent first, so heavy
 * deleting cannot grow every query past Analytics Engine's size limit: about
 * 28 KB of SQL with generated 10-character ids, about 60 KB if every id is an
 * imported 26-character one. Past it, the oldest deletions' traffic shows.
 */
const MAX_DELETED_LINK_IDS = 2000

export function analyticsRequestFailed() {
  return createError({ status: 502, statusText: 'Cloudflare API request failed', data: { code: 'cloudflare_request_failed' } })
}

/**
 * Ids of links the owner deleted within the window, read on every query.
 * ponytail: no cache; one indexed D1 read per analytics request. Cache it per
 * isolate if `rows_read` from this query ever matters.
 */
async function recentlyDeletedLinkIds(event: H3Event): Promise<string[]> {
  const since = Math.floor(Date.now() / 1000) - DELETED_LINK_WINDOW_SECONDS
  let ids: string[]
  try {
    const { results } = await event.context.cloudflare.env.DB
      .prepare(`SELECT id FROM deleted_link_ids WHERE deleted_at >= ? ORDER BY deleted_at DESC LIMIT ${MAX_DELETED_LINK_IDS + 1}`)
      .bind(since)
      .all<{ id: string }>()
    ids = results.map(row => row.id)
  }
  catch (error) {
    // Never show deleted links' traffic because the list could not be read.
    console.error({ event: 'deleted_link_ids.read_failed', errorName: (error as Error)?.name ?? null })
    throw analyticsRequestFailed()
  }
  if (ids.length > MAX_DELETED_LINK_IDS) {
    console.warn({ event: 'deleted_link_ids.over_cap', cap: MAX_DELETED_LINK_IDS })
    ids = ids.slice(0, MAX_DELETED_LINK_IDS)
  }
  // Imported ids may hold control characters, which the analytics filters
  // reject too (query-filter.ts); such a link's traffic stays visible.
  return ids.filter(id => !hasControlCharacter(id))
}

/** An Analytics Engine SQL answer in JSON: `data` holds the rows. */
export type AnalyticsAnswer = { data?: unknown[] } & Record<string, unknown>

/**
 * Sends an Analytics Engine SQL query, leaving out the traffic of links the
 * owner deleted (`index1` is the link id). Every analytics read goes through
 * here: the stats and logs routes, the CSV export and the MCP analytics tools.
 */
export async function useWAE(event: H3Event, query: SelectQueryBuilder<any, any, any>): Promise<AnalyticsAnswer> {
  const { cfAccountId, cfApiToken } = useRuntimeConfig(event)
  if (!cfAccountId || !cfApiToken)
    return { data: [] }

  const deleted = await recentlyDeletedLinkIds(event)
  const visible = deleted.length
    ? query.where(sql<boolean>`${sql.ref('index1')} not in (${sql.join(deleted.map(id => sql.lit(id)))})`)
    : query
  const compiledQuery = compileAnalyticsQuery(visible)

  if (import.meta.dev)
    console.info('useWAE', compiledQuery)

  // nosemgrep: sink-no-raw-fetch-in-server -- fixed Cloudflare API host, not a user-supplied URL
  return $fetch<AnalyticsAnswer>(`https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/analytics_engine/sql`, {
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
    throw analyticsRequestFailed()
  })
}
