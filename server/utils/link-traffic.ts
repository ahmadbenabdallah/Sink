import type { TrafficLinksQuery, TrafficSort } from '#shared/schemas/link-traffic'
import { createError } from 'h3'

/**
 * The Links page's traffic sorts: rank the links stored in D1 by the counts
 * Analytics Engine holds for them, with the card formulas. Pure: no database,
 * no network, so every rule is tested with plain data.
 *
 * R3 only the given links, ids Analytics Engine returns for anything else
 *    are ignored. R4 highest first, ties to the newer link, then the slug.
 * R5 no traffic counts as zero, so those links come last. R6 a page holds the
 *    links strictly after the cursor's key. R7 the counts go with each link.
 */

export interface LinkKey { id: string, slug: string, createdAt: number }
export interface TrafficCounts { visits: number, visitors: number, referers: number }
/** Where a page ends: the last link's value for the sort, then its tie-breakers. */
export interface TrafficSortKey { value: number, createdAt: number, slug: string }
export interface TrafficRow { id: unknown, visits: unknown, visitors: unknown, referers: unknown }

const NO_TRAFFIC: TrafficCounts = { visits: 0, visitors: 0, referers: 0 }
const CURSOR_PREFIX = 't1:'

/** Negative when `a` comes before `b`. */
function compare(a: TrafficSortKey, b: TrafficSortKey): number {
  return b.value - a.value || b.createdAt - a.createdAt || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
}

export function rankLinksByTraffic(
  keys: LinkKey[],
  rows: TrafficRow[],
  sort: TrafficSort,
  after: TrafficSortKey | null,
  limit: number,
): { page: { key: LinkKey, counts: TrafficCounts }[], last: TrafficSortKey | null, complete: boolean } {
  // Analytics Engine sends UInt64 values as strings.
  const countsById = new Map(rows.map(row => [String(row.id), {
    visits: Number(row.visits) || 0,
    visitors: Number(row.visitors) || 0,
    referers: Number(row.referers) || 0,
  }]))
  const ranked = keys
    .map((key) => {
      const counts = countsById.get(key.id) ?? NO_TRAFFIC
      return { key, counts, sortKey: { value: counts[sort], createdAt: key.createdAt, slug: key.slug } }
    })
    .filter(item => !after || compare(item.sortKey, after) > 0)
    .sort((a, b) => compare(a.sortKey, b.sortKey))
  const page = ranked.slice(0, limit)
  const complete = ranked.length <= limit
  return {
    page: page.map(({ key, counts }) => ({ key, counts })),
    last: complete ? null : page.at(-1)!.sortKey,
    complete,
  }
}

type CursorFilter = Pick<TrafficLinksQuery, 'sort' | 'tag' | 'status'>

function invalidCursor() {
  return createError({ status: 400, statusText: 'Invalid pagination cursor', data: { code: 'invalid_cursor' } })
}

export function encodeTrafficCursor(filter: CursorFilter, key: TrafficSortKey): string {
  // encodeURIComponent first: btoa takes Latin-1 only, and a tag can be any text.
  return `${CURSOR_PREFIX}${btoa(encodeURIComponent(JSON.stringify({ sort: filter.sort, tag: filter.tag, status: filter.status, ...key })))}`
}

/** The sort key a cursor ends at, or null without one. A cursor made for another sort, tag or status is refused. */
export function decodeTrafficCursor(cursor: string | undefined, filter: CursorFilter): TrafficSortKey | null {
  if (!cursor)
    return null
  if (!cursor.startsWith(CURSOR_PREFIX))
    throw invalidCursor()
  let decoded: unknown
  try {
    decoded = JSON.parse(decodeURIComponent(atob(cursor.slice(CURSOR_PREFIX.length))))
  }
  catch {
    throw invalidCursor()
  }
  if (typeof decoded !== 'object' || decoded === null)
    throw invalidCursor()
  const fields = decoded as Record<string, unknown>
  if (fields.sort !== filter.sort || fields.tag !== filter.tag || fields.status !== filter.status)
    throw invalidCursor()
  const { value, createdAt, slug } = fields
  if (typeof value !== 'number' || typeof createdAt !== 'number' || typeof slug !== 'string')
    throw invalidCursor()
  return { value, createdAt, slug }
}
