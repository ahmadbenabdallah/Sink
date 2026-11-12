import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { ConnectorUsage } from '../../../shared/types/connector'
import { sql } from 'drizzle-orm'
import { mcpUsage } from '../../database/schema'

/**
 * How often each caller uses the MCP endpoint: one row per caller per UTC day,
 * increased by one for every tool call. Kept in D1, not in the click analytics
 * dataset, so the numbers are exact, need no Cloudflare API credentials to
 * read, and never mix agent calls into click statistics.
 *
 * Every function takes the database handle, like the token store.
 */

/**
 * Tool calls one caller may make per UTC day unless `NUXT_MCP_DAILY_CALL_LIMIT`
 * says otherwise. Each counted call is one D1 row write, and Cloudflare's free
 * plan allows 100,000 a day shared with everything else that writes, so ten
 * callers at this limit use half of it.
 */
export const DEFAULT_DAILY_CALL_LIMIT = 5000

const WINDOW_DAYS = 7
const DAY_MS = 86_400_000

/** The UTC date a call is counted under, as stored: `YYYY-MM-DD`. */
export function usageDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

const warnedLimits = new Set<unknown>()

/**
 * The limit to apply, from the configured value. Unset or empty means the
 * default. Only a plain whole number above zero is a limit; anything else
 * means the default, with a warning, so a typo cannot switch the limit off.
 * The warning is logged once per value, because the limit is resolved on
 * every request.
 */
export function resolveDailyCallLimit(configured: unknown): number {
  if (configured === undefined || configured === '')
    return DEFAULT_DAILY_CALL_LIMIT

  const limit = typeof configured === 'string' && /^\s*\d+\s*$/.test(configured) ? Number(configured) : configured
  if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0)
    return limit

  if (!warnedLimits.has(configured)) {
    warnedLimits.add(configured)
    console.warn({ event: 'mcp_usage.invalid_daily_limit', fallback: DEFAULT_DAILY_CALL_LIMIT })
  }
  return DEFAULT_DAILY_CALL_LIMIT
}

/**
 * Counts one tool call for the caller if it is still under today's limit, and
 * says whether it was.
 *
 * Checking and counting are one statement: the row's count goes up only while
 * it is below the limit, and a row comes back only when it did. Calls that
 * arrive together therefore cannot each read "one below the limit" and all go
 * through, and a call is counted before its tool runs, so a caller that drops
 * the connection afterwards has still been counted.
 *
 * Throws when the database fails. What that means for the tool call is the
 * caller's decision, not this function's.
 */
export async function reserveToolCall(db: DrizzleD1Database, callerId: string, dailyLimit: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const counted = await db
    .insert(mcpUsage)
    .values({ callerId, day: usageDay(), calls: 1, lastUsedAt: now })
    .onConflictDoUpdate({
      target: [mcpUsage.callerId, mcpUsage.day],
      set: { calls: sql`${mcpUsage.calls} + 1`, lastUsedAt: now },
      setWhere: sql`${mcpUsage.calls} < ${dailyLimit}`,
    })
    .returning({ calls: mcpUsage.calls })
  return counted.length > 0
}

/**
 * Usage per caller: calls over today and the six days before it, and the most
 * recent call on record, however long ago. A caller that never made a call has
 * no entry. Throws when usage cannot be read, so a caller can tell "unknown"
 * from "none".
 */
// ponytail: reads every row. The table grows by one row per caller per day and
// is never pruned, which is a few thousand rows a year. If it is ever pruned,
// keep each caller's newest row, or its last use is lost.
export async function usageSummary(db: DrizzleD1Database): Promise<Map<string, ConnectorUsage>> {
  const windowStart = usageDay(new Date(Date.now() - (WINDOW_DAYS - 1) * DAY_MS))
  const rows = await db
    .select({
      callerId: mcpUsage.callerId,
      calls7d: sql<number>`sum(case when ${mcpUsage.day} >= ${windowStart} then ${mcpUsage.calls} else 0 end)`,
      lastUsedAt: sql<number>`max(${mcpUsage.lastUsedAt})`,
    })
    .from(mcpUsage)
    .groupBy(mcpUsage.callerId)

  return new Map(rows.map(row => [row.callerId, { calls7d: Number(row.calls7d), lastUsedAt: Number(row.lastUsedAt) }]))
}
