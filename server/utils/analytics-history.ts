import type { H3Event } from 'h3'
import type { AnalyticsHistory } from '#shared/types/analytics-history'
import type { AnalyticsAnswer } from './cloudflare'
import { daySteps, ROLLUP_DIMENSIONS } from './analytics-export'
import { analyticsRequestFailed } from './cloudflare'

/**
 * Days older than three months are read from the daily rollups in D1
 * (`analytics_daily`, `analytics_daily_breakdown`), because Analytics Engine
 * has deleted them. Only the counters, the views chart by day and the metric
 * lists exist per day; everything else reads Analytics Engine only.
 *
 * Two limits keep the reads inside the free plan's 5,000,000 D1 rows read a
 * day, which the link store needs too: one request reads at most 366 old days,
 * and once the old-day reads have read 2,000,000 rows today (D1's own
 * `rows_read`, kept in `analytics_export_budget`), old days are not read until
 * the next UTC day. Visitors can flood the breakdowns with distinct values, so
 * the rows read follow the data stored, not the range.
 * ponytail: the budget is checked before each request and counted after it,
 * and a page load sends about 15 requests at once, so one page load (more
 * with several tabs) can go over it by what it reads. 2,000,000 leaves about
 * 3,000,000 of the 5,000,000 for that and the link store; reserve an estimate
 * before reading if it ever falls short.
 */

const DAY_SECONDS = 86_400
/** Days before the start of the UTC day this many days ago read D1. Analytics Engine keeps 89 to 92 days. */
export const HISTORY_BOUNDARY_DAYS = 88
/** A day is finished when all of these are done. Adding a dimension later leaves every earlier day unfinished until it is rolled up again. */
const ROLLUP_STEPS_PER_DAY = daySteps().filter(step => !step.startsWith('archive:')).length
/** Old days one request reads, counted back from the boundary. */
const MAX_OLD_DAYS = 366
const ROWS_READ_PER_DAY = 2_000_000
/** Query keys that are not filters. */
const NOT_FILTERS = new Set(['startAt', 'endAt', 'limit', 'type', 'unit', 'clientTimezone'])
/** The filters the daily rows can apply: they hold the link id and the slug. */
const DAILY_FILTERS = new Set(['id', 'slug'])

export interface HistoryPlan {
  /** UTC days, `YYYY-MM-DD`, read from D1. */
  oldDays: string[]
  /** The rest of the range, read from Analytics Engine; null when the whole range is older. */
  recent: { startAt: number, endAt: number } | null
  /** Old days before the 366 read, counted as without data. */
  skippedDays: number
}

type HistoryQuery = { startAt?: number, endAt?: number } & Record<string, unknown>

/**
 * Splits a range at the start of the UTC day 88 days ago. Null without a
 * start (the link cards and MCP tools), or when the whole range is newer.
 */
export function historyPlan(query: HistoryQuery, now: number): HistoryPlan | null {
  if (!query.startAt)
    return null
  const boundary = Math.floor(now / 1000 / DAY_SECONDS) * DAY_SECONDS - HISTORY_BOUNDARY_DAYS * DAY_SECONDS
  if (query.startAt >= boundary)
    return null
  const endAt = query.endAt ?? Math.floor(now / 1000)
  const startDay = Math.floor(query.startAt / DAY_SECONDS) * DAY_SECONDS
  const firstDay = Math.max(startDay, boundary - MAX_OLD_DAYS * DAY_SECONDS)
  // Counted, not listed, so a start however far back costs nothing.
  const lastSkipped = Math.min(Math.floor(endAt / DAY_SECONDS) * DAY_SECONDS, firstDay - DAY_SECONDS)
  const skippedDays = lastSkipped >= startDay ? (lastSkipped - startDay) / DAY_SECONDS + 1 : 0
  const oldDays: string[] = []
  for (let day = firstDay; day < boundary && day <= endAt; day += DAY_SECONDS)
    oldDays.push(new Date(day * 1000).toISOString().slice(0, 10))
  return { oldDays, recent: endAt >= boundary ? { startAt: boundary, endAt } : null, skippedDays }
}

/** Whether the query has a filter the daily rows cannot apply, such as a country. */
export function needsUnavailableFilter(query: Record<string, unknown>): boolean {
  return Object.entries(query).some(([key, value]) => !NOT_FILTERS.has(key) && !DAILY_FILTERS.has(key) && typeof value === 'string' && value !== '')
}

interface CounterRow { id?: unknown, visits: unknown, visitors: unknown, referers: unknown }
interface ViewRow { time: unknown, visits: unknown, visitors: unknown }
interface MetricRow { name: unknown, count: unknown }

/** Visits add exactly; visitors and referers become sums of daily values, an estimate. */
export function mergeCounters(recent: CounterRow[], old: CounterRow[], byId: boolean) {
  const totals = new Map<string, { visits: number, visitors: number, referers: number }>()
  for (const row of [...recent, ...old]) {
    const key = byId ? String(row.id) : ''
    const total = totals.get(key) ?? { visits: 0, visitors: 0, referers: 0 }
    total.visits += Number(row.visits)
    total.visitors += Number(row.visitors)
    total.referers += Number(row.referers)
    totals.set(key, total)
  }
  return [...totals].map(([id, total]) => byId ? { id, ...total } : total)
}

/**
 * Old days first, labelled by UTC date, then the recent points in the viewer's
 * time zone. West of UTC, the first recent day has the label of the last old
 * day; points that share a label are added.
 */
export function mergeViews(old: ViewRow[], recent: ViewRow[]) {
  const points = new Map<string, { time: string, visits: number, visitors: number }>()
  for (const row of [...old, ...recent]) {
    const time = String(row.time)
    const point = points.get(time) ?? { time, visits: 0, visitors: 0 }
    point.visits += Number(row.visits)
    point.visitors += Number(row.visitors)
    points.set(time, point)
  }
  return [...points.values()]
}

/** Counts add per name. Each part is already cut to its top values, so a combined list is approximate. */
export function mergeMetrics(old: MetricRow[], recent: MetricRow[], limit: number) {
  const counts = new Map<string, number>()
  for (const row of [...old, ...recent])
    counts.set(String(row.name), (counts.get(String(row.name)) ?? 0) + Number(row.count))
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, limit)
}

function filterValues(value: unknown): string[] {
  return typeof value === 'string' && value ? value.split(',') : []
}

/**
 * The WHERE clause shared by every old-day read: the days, no deleted link
 * (every recorded id, not only recent ones), and the link and slug filters.
 * `alias` is `d` (analytics_daily) or `b` (analytics_daily_breakdown, whose
 * slug comes from the day's totals row of the same link).
 */
function oldWhere(alias: 'd' | 'b', days: string[], query: Record<string, unknown>): { where: string, params: unknown[] } {
  const parts = [`${alias}.day IN (SELECT value FROM json_each(?))`, `${alias}.link_id NOT IN (SELECT id FROM deleted_link_ids)`]
  const params: unknown[] = [JSON.stringify(days)]
  const ids = filterValues(query.id).filter(Boolean)
  if (ids.length) {
    parts.push(`${alias}.link_id IN (SELECT value FROM json_each(?))`)
    params.push(JSON.stringify(ids))
  }
  const slugs = filterValues(query.slug)
  if (slugs.length) {
    parts.push(alias === 'd'
      ? 'd.slug IN (SELECT value FROM json_each(?))'
      : 'EXISTS (SELECT 1 FROM analytics_daily d WHERE d.day = b.day AND d.link_id = b.link_id AND d.slug IN (SELECT value FROM json_each(?)))')
    params.push(JSON.stringify(slugs))
  }
  return { where: parts.join(' AND '), params }
}

/** Counts the D1 rows a request's old-day reads read. */
interface ReadMeter { rowsRead: number }

async function all<T>(env: Cloudflare.Env, meter: ReadMeter, statement: string, params: unknown[]): Promise<T[]> {
  const result = await env.DB.prepare(statement).bind(...params).all<T>()
  meter.rowsRead += result.meta.rows_read ?? 0
  return result.results
}

/** The days whose 13 rollup steps are all completed. */
async function finishedDays(env: Cloudflare.Env, meter: ReadMeter, days: string[]): Promise<string[]> {
  const rows = await all<{ day: string }>(env, meter, `SELECT day FROM analytics_export_steps WHERE day IN (SELECT value FROM json_each(?)) AND step NOT LIKE 'archive:%' AND completed_at IS NOT NULL GROUP BY day HAVING COUNT(*) = ?`, [JSON.stringify(days), ROLLUP_STEPS_PER_DAY])
  return rows.map(row => row.day)
}

function oldCounters(env: Cloudflare.Env, meter: ReadMeter, days: string[], query: Record<string, unknown>) {
  const byId = filterValues(query.id).length > 0
  const { where, params } = oldWhere('d', days, query)
  const rows = all<CounterRow>(env, meter, `SELECT ${byId ? 'd.link_id AS id, ' : ''}SUM(d.visits) AS visits, SUM(d.visitors) AS visitors, SUM(d.referers) AS referers FROM analytics_daily d WHERE ${where}${byId ? ' GROUP BY d.link_id' : ''}`, params)
  // Without GROUP BY, SUM over no rows is one row of nulls.
  return rows.then(result => result.filter(row => row.visits !== null))
}

function oldViews(env: Cloudflare.Env, meter: ReadMeter, days: string[], query: Record<string, unknown>) {
  const { where, params } = oldWhere('d', days, query)
  return all<ViewRow>(env, meter, `SELECT d.day AS time, SUM(d.visits) AS visits, SUM(d.visitors) AS visitors FROM analytics_daily d WHERE ${where} GROUP BY d.day ORDER BY d.day`, params)
}

function oldMetrics(env: Cloudflare.Env, meter: ReadMeter, days: string[], query: Record<string, unknown>, type: string, limit: number) {
  if (type === 'slug') {
    const { where, params } = oldWhere('d', days, query)
    return all<MetricRow>(env, meter, `SELECT d.slug AS name, SUM(d.visits) AS count FROM analytics_daily d WHERE ${where} GROUP BY d.slug ORDER BY count DESC LIMIT ?`, [...params, limit])
  }
  const { where, params } = oldWhere('b', days, query)
  return all<MetricRow>(env, meter, `SELECT b.value AS name, SUM(b.visits) AS count FROM analytics_daily_breakdown b WHERE b.dimension = ? AND ${where} GROUP BY b.value ORDER BY count DESC LIMIT ?`, [type, ...params, limit])
}

/** Metric types the daily rows hold: the breakdown dimensions, and the slug from the totals. */
function isDailyMetric(type: string): boolean {
  return type === 'slug' || (ROLLUP_DIMENSIONS as readonly string[]).includes(type)
}

/** Runs D1 reads; an error becomes a fixed 502, like useWAE, because a D1 error message can carry SQL text. */
async function readD1<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  }
  catch (error) {
    console.error({ event: 'analytics_history.read_failed', errorName: (error as Error)?.name ?? null })
    throw analyticsRequestFailed()
  }
}

/**
 * Reads the recent part from Analytics Engine with the narrowed range, the
 * old days from D1, and merges them. `history` says how the old part was read.
 * When the old days are not read from D1 (a filter the daily rows cannot
 * apply, today's read budget used up, or no rollup ever finished, as on Pages),
 * the whole range reads Analytics Engine, which still holds days 88 to about 92.
 */
async function withHistory(
  event: H3Event,
  plan: HistoryPlan,
  query: Record<string, unknown> & { startAt?: number, endAt?: number },
  readRecent: (range: { startAt: number, endAt: number }) => Promise<AnalyticsAnswer>,
  readOld: (env: Cloudflare.Env, meter: ReadMeter, days: string[]) => Promise<unknown[]>,
  merge: (recent: unknown[], old: unknown[]) => unknown[],
  dailyAvailable = true,
): Promise<AnalyticsAnswer & { history?: AnalyticsHistory }> {
  const fullRange = { startAt: query.startAt!, endAt: query.endAt ?? Math.floor(Date.now() / 1000) }
  const oldDayCount = plan.oldDays.length + plan.skippedDays
  if (!dailyAvailable || needsUnavailableFilter(query))
    return { ...await readRecent(fullRange), history: { daysFromRollups: 0, missingDays: oldDayCount, unavailable: 'filter' } }

  const env = event.context.cloudflare.env
  const utcDay = new Date().toISOString().slice(0, 10)
  const { rolledUp, rowsRead } = await readD1(async () => ({
    rolledUp: await env.DB.prepare(`SELECT 1 AS found FROM analytics_export_steps WHERE step NOT LIKE 'archive:%' AND completed_at IS NOT NULL LIMIT 1`).first(),
    rowsRead: (await env.DB.prepare('SELECT rows_read FROM analytics_export_budget WHERE utc_day = ?').bind(utcDay).first<{ rows_read: number }>())?.rows_read ?? 0,
  }))
  // No rollups at all: answer as before this feature, with no note.
  if (!rolledUp)
    return readRecent(fullRange)
  if (rowsRead >= ROWS_READ_PER_DAY)
    return { ...await readRecent(fullRange), history: { daysFromRollups: 0, missingDays: oldDayCount, unavailable: 'budget' } }

  const recent = plan.recent ? await readRecent(plan.recent) : { data: [] }
  const { days, old } = await readD1(async () => {
    const meter: ReadMeter = { rowsRead: 0 }
    const days = plan.oldDays.length ? await finishedDays(env, meter, plan.oldDays) : []
    const old = days.length ? await readOld(env, meter, days) : []
    await env.DB.prepare('INSERT INTO analytics_export_budget (utc_day, rows_read) VALUES (?, ?) ON CONFLICT (utc_day) DO UPDATE SET rows_read = rows_read + excluded.rows_read')
      .bind(utcDay, meter.rowsRead)
      .run()
    return { days, old }
  })
  return {
    ...recent,
    data: merge(recent.data ?? [], old),
    history: { daysFromRollups: days.length, missingDays: oldDayCount - days.length },
  }
}

export function countersWithHistory(event: H3Event, plan: HistoryPlan, query: Record<string, unknown>, readRecent: (range: { startAt: number, endAt: number }) => Promise<AnalyticsAnswer>) {
  const byId = filterValues(query.id).length > 0
  return withHistory(event, plan, query, readRecent, (env, meter, days) => oldCounters(env, meter, days, query), (recent, old) => mergeCounters(recent as CounterRow[], old as CounterRow[], byId))
}

export function viewsWithHistory(event: H3Event, plan: HistoryPlan, query: Record<string, unknown>, readRecent: (range: { startAt: number, endAt: number }) => Promise<AnalyticsAnswer>) {
  return withHistory(event, plan, query, readRecent, (env, meter, days) => oldViews(env, meter, days, query), (recent, old) => mergeViews(old as ViewRow[], recent as ViewRow[]))
}

export function metricsWithHistory(event: H3Event, plan: HistoryPlan, query: Record<string, unknown> & { type: string, limit: number }, readRecent: (range: { startAt: number, endAt: number }) => Promise<AnalyticsAnswer>) {
  return withHistory(event, plan, query, readRecent, (env, meter, days) => oldMetrics(env, meter, days, query, query.type, query.limit), (recent, old) => mergeMetrics(old as MetricRow[], recent as MetricRow[], query.limit), isDailyMetric(query.type))
}

/** For views finer than a day and the heatmap: the old days exist only per day, so they are not read. */
export function recentOnlyHistory(plan: HistoryPlan): AnalyticsHistory {
  return { daysFromRollups: 0, missingDays: plan.oldDays.length + plan.skippedDays, unavailable: 'unit' }
}
