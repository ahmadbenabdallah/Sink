import type { TrafficLinkListResponse } from '#shared/types/link'
import type { TrafficRow } from '../../utils/link-traffic'
import { TrafficLinksQuerySchema } from '#shared/schemas/link-traffic'
import { decodeTrafficCursor, encodeTrafficCursor, rankLinksByTraffic } from '../../utils/link-traffic'

// No defineRouteMeta: the traffic sorts are for the dashboard, and the OpenAPI
// hook (server/plugins/openapi.ts) removes this route from the public docs.

function analyticsUnavailable() {
  return createError({ status: 503, statusText: 'Analytics unavailable', data: { code: 'analytics_unavailable' } })
}

/**
 * One page of links ranked by traffic (server/utils/link-traffic.ts): the
 * matching D1 links, one Analytics Engine query with the card formulas, the
 * ranking, then the page's full rows.
 *
 * ponytail: every page reads every matching link's key (about N D1 rows) and
 * every link's counts, so scrolling the whole list reads about N²/24 rows,
 * about 94,000 at 1,500 links. Rank from `analytics_daily` if that ever matters.
 */
export default eventHandler(async (event): Promise<TrafficLinkListResponse> => {
  const query = await getValidatedQuery(event, TrafficLinksQuerySchema.parse)
  const after = decodeTrafficCursor(query.cursor, query)
  // useWAE answers no rows without credentials; a ranking of zeros would mislead (R8).
  const { cfAccountId, cfApiToken } = useRuntimeConfig(event)
  if (!cfAccountId || !cfApiToken)
    throw analyticsUnavailable()

  const keys = await listLinkKeys(event, { tag: query.tag, status: query.status })
  let rows: TrafficRow[]
  try {
    rows = ((await useWAE(event, buildCountersQuery({}, event, { groupByLink: true }))).data ?? []) as TrafficRow[]
  }
  catch (error) {
    // useWAE logs most upstream failures, but not rejected credentials or a local error.
    console.error({ event: 'link_traffic.analytics_failed', code: (error as { data?: { code?: string } })?.data?.code ?? null, errorName: (error as Error)?.name ?? null })
    throw analyticsUnavailable()
  }
  if (rows.length >= TRAFFIC_ROW_CAP) {
    console.warn({ event: 'link_traffic.truncated', rows: rows.length })
    throw analyticsUnavailable()
  }

  const ranked = rankLinksByTraffic(keys, rows, query.sort, after, query.limit)
  const links = await getLinksBySlugs(event, ranked.page.map(item => item.key.slug))
  // Counts only for the links that loaded: one deleted in between is left out of both.
  const loaded = new Set(links.map(link => link.slug))
  return {
    links: sanitizeLinksPassword(links),
    counters: Object.fromEntries(ranked.page.filter(item => loaded.has(item.key.slug)).map(item => [item.key.id, item.counts])),
    cursor: ranked.last ? encodeTrafficCursor(query, ranked.last) : '',
    list_complete: ranked.complete,
  }
})
