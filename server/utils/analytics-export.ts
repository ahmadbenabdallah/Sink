import { and, asc, sql as drizzleSql, eq, gte, isNull, like, lt, not, or } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { sql } from 'kysely'
import { analyticsExportSteps } from '../database/schema'
import { blobsMap, doublesMap, logsMap } from './access-log'
import { compileAnalyticsQuery, createAnalyticsQuery, weightedDistinct } from './analytics-sql'
import { uploadBackupParts } from './backup-json-stream'

/**
 * Copies every Analytics Engine record into R2, one file per UTC hour, and
 * writes daily totals and breakdowns per link to D1, before Analytics Engine
 * deletes the records after about three months.
 *
 * It runs on a 5-minute cron trigger. On the free plan one run gets 10 ms of
 * CPU, so a run does at most a few steps, and a step mostly waits on the
 * network: the records are streamed into R2 without being parsed.
 */

export const ARCHIVE_PREFIX = 'analytics/raw/'
/** Days younger than this may still receive late records. */
const MIN_AGE_DAYS = 2
/**
 * Analytics Engine keeps three months, 89 to 92 days. Days up to 90 old are
 * covered, oldest first: in a short month the oldest of them may already be
 * partly deleted, and the job then keeps whatever is left.
 */
const MAX_AGE_DAYS = 90
const STEPS_PER_RUN = 3
const MAX_ATTEMPTS = 3
/** A claim older than this belongs to a run that was killed. */
const CLAIM_TTL_SECONDS = 15 * 60
/**
 * At about 1,000 clicks a day an hour holds about 42 records. An hour above
 * this is an anomaly, such as a flood of requests: its first records are kept
 * and it logs `analytics_export.hour_truncated`.
 * ponytail: no splitting of busy hours; add it if `hour_truncated` shows up for real traffic.
 */
const MAX_ARCHIVE_ROWS = 10_000
const REQUEST_TIMEOUT_MS = 20_000
const DAY_MS = 86_400_000

/** The dimensions broken down per link and day; `ip` and `ua` stay in the archive only. */
export const ROLLUP_DIMENSIONS = ['referer', 'country', 'region', 'city', 'timezone', 'language', 'os', 'browser', 'browserType', 'device', 'deviceType', 'COLO'] as const
/** Rows per totals or breakdown page. If runs are killed for CPU, lower it. */
const ROLLUP_PAGE_ROWS = 500
/**
 * A page goes to D1 as one JSON value, and D1 rejects values over 2 MB.
 * Records written before the referer and language caps can hold values of
 * many kilobytes, so a larger page counts an attempt and parks after 3.
 */
const MAX_PAGE_JSON_BYTES = 1_000_000
/**
 * The free plan allows 100,000 D1 rows written a day. The rollups stop for the
 * UTC day at half of that, so link edits and MCP usage keep working when
 * visitor-controlled values (referers, languages) are flooded.
 */
const ROLLUP_ROWS_PER_DAY = 50_000
/** The rollups stop above this, leaving room under the free plan's 500 MB per database. */
const MAX_DATABASE_BYTES = 400 * 1024 * 1024

export interface AnalyticsExportOptions {
  accountId: string
  apiToken: string
  dataset: string
  /** Milliseconds; the cron run's scheduled time. */
  now: number
  /** Overrides the database size above which the rollups stop; for tests. */
  maxDatabaseBytes?: number
}

export interface AnalyticsExportSummary {
  stepsDone: number
  stepsFailed: number
  stepsParked: number
  stopped?: 'not_configured' | 'no_r2' | 'not_migrated' | 'analytics_unavailable'
}

/** Full UTC days from 90 to 2 days old, oldest first, as `YYYY-MM-DD`. */
export function eligibleDays(now: number): string[] {
  const today = Math.floor(now / DAY_MS) * DAY_MS
  const days: string[] = []
  for (let age = MAX_AGE_DAYS; age >= MIN_AGE_DAYS; age--)
    days.push(new Date(today - age * DAY_MS).toISOString().slice(0, 10))
  return days
}

/** One UTC hour as `[start, end)` in unix seconds. */
export function hourWindow(day: string, hour: number): { start: number, end: number } {
  const start = Date.parse(`${day}T00:00:00Z`) / 1000 + hour * 3600
  return { start, end: start + 3600 }
}

export function archiveKey(day: string, hour: number): string {
  return `${ARCHIVE_PREFIX}${day}/${String(hour).padStart(2, '0')}.ndjson`
}

/**
 * Passes bytes through unchanged and counts newline bytes, with the native
 * `indexOf`, so the archive can check it received every record without
 * parsing any of them.
 */
export function createLineCounter() {
  let lines = 0
  let lastByte = -1
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let index = chunk.indexOf(10)
      while (index !== -1) {
        lines++
        index = chunk.indexOf(10, index + 1)
      }
      if (chunk.byteLength > 0)
        lastByte = chunk[chunk.byteLength - 1]!
      controller.enqueue(chunk)
    },
  })
  return { stream, result: () => ({ lines, endsWithNewline: lastByte === 10 }) }
}

class AnalyticsRequestError extends Error {
  constructor(readonly status: number) {
    super(`Analytics Engine answered ${status}`)
  }
}

/**
 * The only failure that counts against a step: the answer for this one hour
 * was wrong. Every other failure (an error status, a rejected query, a broken
 * connection, a timeout, R2) would hit every hour alike, so it stops the run
 * and counts against no step.
 */
class StepError extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

async function queryAnalyticsEngine(options: AnalyticsExportOptions, statement: string): Promise<Response> {
  // nosemgrep: sink-no-raw-fetch-in-server -- fixed Cloudflare API host, not a user-supplied URL
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.apiToken}` },
    body: statement,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    // Never read or relay the body: it can echo the SQL text or the account id.
    await response.body?.cancel()
    throw new AnalyticsRequestError(response.status)
  }
  return response
}

function windowCondition(start: number, end: number) {
  return sql<boolean>`${sql.ref('timestamp')} >= toDateTime(${sql.lit(start)}) and ${sql.ref('timestamp')} < toDateTime(${sql.lit(end)})`
}

function countStatement(dataset: string, start: number, end: number): string {
  return compileAnalyticsQuery(createAnalyticsQuery(dataset)
    .select(sql<number>`count()`.as('records'))
    .where(windowCondition(start, end)))
}

/** Every column the access log writes, under its readable name, plus the sampling weight. */
function rawStatement(dataset: string, start: number, end: number, limit: number): string {
  const columns = [
    'timestamp' as const,
    '_sample_interval' as const,
    'index1' as const,
    ...Object.entries({ ...blobsMap, ...doublesMap }).map(([column, name]) => sql`${sql.ref(column)}`.as(name)),
  ]
  const query = compileAnalyticsQuery(createAnalyticsQuery(dataset)
    .select(columns)
    .where(windowCondition(start, end))
    .orderBy('timestamp')
    .limit(sql.lit(limit)))
  return `${query} FORMAT JSONEachRow`
}

/** Returns how many records Analytics Engine holds for the hour and how many were kept. */
async function archiveHour(r2: R2Bucket, day: string, hour: number, options: AnalyticsExportOptions): Promise<{ records: number, kept: number }> {
  const { start, end } = hourWindow(day, hour)
  const counted = await (await queryAnalyticsEngine(options, countStatement(options.dataset, start, end))).json() as { data?: { records?: unknown }[] }
  const records = Number(counted.data?.[0]?.records)
  if (!Number.isSafeInteger(records) || records < 0)
    throw new StepError('bad_count')
  const kept = Math.min(records, MAX_ARCHIVE_ROWS)
  if (kept === 0)
    return { records, kept }

  const response = await queryAnalyticsEngine(options, rawStatement(options.dataset, start, end, kept))
  if (!response.body)
    throw new StepError('empty_body')
  const counter = createLineCounter()
  const upload = await r2.createMultipartUpload(archiveKey(day, hour), {
    httpMetadata: { contentType: 'application/x-ndjson' },
    customMetadata: { records: String(records), expectedRows: String(kept) },
  })
  try {
    const parts = await uploadBackupParts(upload, response.body.pipeThrough(counter.stream))
    if (parts.length === 0)
      throw new StepError('empty_body')
    // The file is kept even when the count differs: a partial copy is better
    // than none once the day leaves Analytics Engine.
    await upload.complete(parts)
  }
  catch (error) {
    await upload.abort().catch(() => {})
    throw error
  }
  const { lines, endsWithNewline } = counter.result()
  if (lines !== kept || !endsWithNewline)
    throw new StepError('count_mismatch')
  return { records, kept }
}

/** One UTC day as `[start, end)` in unix seconds. */
function dayWindow(day: string): { start: number, end: number } {
  const start = Date.parse(`${day}T00:00:00Z`) / 1000
  return { start, end: start + 86_400 }
}

/** One page of the day's totals, ordered by link id, starting after `after`. */
function totalsStatement(dataset: string, day: string, after: string | null): string {
  const { start, end } = dayWindow(day)
  let query = createAnalyticsQuery(dataset)
    .select([
      sql.ref('index1').as('link_id'),
      // ponytail: the alphabetically largest slug if a link's slug changed that day.
      sql<string>`max(${sql.ref(logsMap.slug!)})`.as('slug'),
      sql<number>`SUM(_sample_interval)`.as('visits'),
      weightedDistinct(logsMap.ip!).as('visitors'),
      weightedDistinct(logsMap.referer!).as('referers'),
    ])
    .where(windowCondition(start, end))
  if (after !== null)
    query = query.where(sql<boolean>`index1 > ${sql.lit(after)}`)
  const compiled = compileAnalyticsQuery(query
    .groupBy('index1')
    .orderBy('index1')
    .limit(sql.lit(ROLLUP_PAGE_ROWS)))
  return `${compiled} FORMAT JSONEachRow`
}

/** One page of a dimension, ordered by `(link id, value)`, starting after `after`. */
function breakdownStatement(dataset: string, day: string, column: string, after: [string, string] | null): string {
  const { start, end } = dayWindow(day)
  let query = createAnalyticsQuery(dataset)
    .select([
      sql.ref('index1').as('link_id'),
      sql.ref(column).as('value'),
      sql<number>`SUM(_sample_interval)`.as('visits'),
      weightedDistinct(logsMap.ip!).as('visitors'),
    ])
    .where(windowCondition(start, end))
  if (after)
    query = query.where(sql<boolean>`(index1 > ${sql.lit(after[0])} or (index1 = ${sql.lit(after[0])} and ${sql.ref(column)} > ${sql.lit(after[1])}))`)
  const compiled = compileAnalyticsQuery(query
    .groupBy([sql.ref('index1'), sql.ref(column)])
    .orderBy(sql.ref('index1'))
    .orderBy(sql.ref(column))
    .limit(sql.lit(ROLLUP_PAGE_ROWS)))
  return `${compiled} FORMAT JSONEachRow`
}

/** Reads a JSONEachRow answer; a line that is not JSON is a wrong answer for this step. */
async function readRows(response: Response): Promise<Record<string, unknown>[]> {
  return (await response.text()).split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>
    }
    catch {
      throw new StepError('bad_row')
    }
  })
}

function rowText(value: unknown): string {
  if (typeof value !== 'string')
    throw new StepError('bad_row')
  return value
}

/** A non-negative number, or a decimal string: Analytics Engine sends UInt64 values as strings. */
function rowCount(value: unknown): number {
  const valid = typeof value === 'number'
    ? Number.isFinite(value) && value >= 0
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
  if (!valid)
    throw new StepError('bad_row')
  return Math.round(Number(value))
}

/**
 * A rollup query with a resume key carries a visitor-controlled value, so a
 * rejection (400 or 422) may be specific to this step: it counts an attempt
 * and parks after 3, rather than stopping every run at this step. A query
 * with no resume key has the same shape for every step, so its rejection
 * stops the run like any other failure.
 */
async function queryRollup(options: AnalyticsExportOptions, statement: string, hasResumeKey: boolean): Promise<Record<string, unknown>[]> {
  try {
    return await readRows(await queryAnalyticsEngine(options, statement))
  }
  catch (error) {
    if (hasResumeKey && error instanceof AnalyticsRequestError && (error.status === 400 || error.status === 422))
      throw new StepError(`status_${error.status}`)
    throw error
  }
}

function pageJson(rows: unknown[][]): string {
  const json = JSON.stringify(rows)
  if (new TextEncoder().encode(json).length > MAX_PAGE_JSON_BYTES)
    throw new StepError('page_too_large')
  return json
}

/** `excluded.*` keeps a repeated page's rows the same; `WHERE true` lets SQLite read `ON CONFLICT` after a `SELECT`. */
const TOTALS_UPSERT = `INSERT INTO analytics_daily (day, link_id, slug, visits, visitors, referers)
  SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]') FROM json_each(?2) WHERE true
  ON CONFLICT (day, link_id) DO UPDATE SET slug = excluded.slug, visits = excluded.visits, visitors = excluded.visitors, referers = excluded.referers`
const BREAKDOWN_UPSERT = `INSERT INTO analytics_daily_breakdown (dimension, day, link_id, value, visits, visitors)
  SELECT ?1, ?2, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?3) WHERE true
  ON CONFLICT (dimension, day, link_id, value) DO UPDATE SET visits = excluded.visits, visitors = excluded.visitors`

/**
 * Runs one page of a rollup step: the day's totals, or one dimension's
 * breakdown, 500 rows per page. The rows go in as one JSON parameter, so the
 * page, the step's progress and the write budget are three statements in one
 * batch: a page is never counted without its rows, and a repeated page writes
 * the same rows. If another run took the claim back meanwhile, the progress
 * update matches no row but the page is still written, which repeats the same
 * rows and only over-counts the budget.
 * Returns the number of rollup rows written.
 */
async function runRollupStep(env: Cloudflare.Env, step: ClaimedStep, options: AnalyticsExportOptions, now: number): Promise<number> {
  const after = step.nextKey === null ? null : JSON.parse(step.nextKey) as unknown
  let rows: unknown[][]
  let upsert: D1PreparedStatement
  if (step.step === 'totals') {
    const answer = await queryRollup(options, totalsStatement(options.dataset, step.day, after as string | null), after !== null)
    rows = answer.map(row => [rowText(row.link_id), rowText(row.slug), rowCount(row.visits), rowCount(row.visitors), rowCount(row.referers)])
    upsert = env.DB.prepare(TOTALS_UPSERT).bind(step.day, pageJson(rows))
  }
  else {
    const dimension = step.step.slice('breakdown:'.length)
    const column = logsMap[dimension as keyof typeof logsMap] as string
    const answer = await queryRollup(options, breakdownStatement(options.dataset, step.day, column, after as [string, string] | null), after !== null)
    rows = answer.map(row => [rowText(row.link_id), rowText(row.value), rowCount(row.visits), rowCount(row.visitors)])
    upsert = env.DB.prepare(BREAKDOWN_UPSERT).bind(dimension, step.day, pageJson(rows))
  }

  const last = rows.at(-1)
  const nextKey = rows.length === ROLLUP_PAGE_ROWS
    ? JSON.stringify(step.step === 'totals' ? last![0] : [last![0], last![1]])
    : null
  const progress = nextKey === null
    ? env.DB.prepare('UPDATE analytics_export_steps SET completed_at = ?, started_at = NULL, next_key = NULL WHERE day = ? AND step = ? AND started_at = ?').bind(now, step.day, step.step, now)
    : env.DB.prepare('UPDATE analytics_export_steps SET next_key = ?, started_at = NULL WHERE day = ? AND step = ? AND started_at = ?').bind(nextKey, step.day, step.step, now)
  // ponytail: counts rows upserted, not D1's `meta.rows_written`, so the
  // budget update fits in the same batch; on these tables, with no secondary
  // index, each upsert writes one row.
  const budget = env.DB.prepare('INSERT INTO analytics_export_budget (utc_day, rows_written) VALUES (?, ?) ON CONFLICT (utc_day) DO UPDATE SET rows_written = rows_written + excluded.rows_written')
    .bind(new Date(options.now).toISOString().slice(0, 10), rows.length)
  await env.DB.batch(rows.length ? [upsert, progress, budget] : [progress, budget])
  return rows.length
}

type Database = ReturnType<typeof drizzle>

/** Every step of one day: 24 archive hours, then the rollups. */
export function daySteps(): string[] {
  return [
    ...Array.from({ length: 24 }, (_, hour) => `archive:${String(hour).padStart(2, '0')}`),
    ...ROLLUP_DIMENSIONS.map(dimension => `breakdown:${dimension}`),
    'totals',
  ]
}

/**
 * The eligible days from the one holding the oldest record Analytics Engine
 * has, so a new install does not spend days asking about empty ones. With no
 * record, or a first record newer than the window, only the newest day: its
 * steps mark the window as seeded for the UTC day.
 */
export function daysFromFirstRecord(days: string[], firstRecord: number | null): string[] {
  const first = firstRecord === null ? null : new Date(firstRecord * 1000).toISOString().slice(0, 10)
  const from = first === null ? [] : days.filter(day => day >= first)
  return from.length ? from : [days.at(-1)!]
}

/** The oldest-record query failed or answered something unexpected: the run stops and seeds nothing, and the next run asks again. */
class SeedUnavailable extends Error {
  constructor(readonly reason: string, readonly status: number | null = null) {
    super(reason)
  }
}

/**
 * The oldest record's time within the window, in unix seconds, or null when
 * Analytics Engine holds none. Only an answer of exactly zero records means
 * none: any other unexpected answer throws, because "none" marks every
 * earlier day done.
 * ponytail: if Analytics Engine answers min() from sampled data, the oldest
 * record can come back late and the sparse first day be skipped. Seed a day
 * earlier than the answer if that ever shows up.
 */
async function firstRecordTime(options: AnalyticsExportOptions, fromDay: string): Promise<number | null> {
  const statement = compileAnalyticsQuery(createAnalyticsQuery(options.dataset)
    .select([
      sql<number>`toUnixTimestamp(min(${sql.ref('timestamp')}))`.as('first'),
      sql<number>`count()`.as('records'),
    ])
    .where(sql<boolean>`${sql.ref('timestamp')} >= toDateTime(${sql.lit(dayWindow(fromDay).start)})`))
  let answer: { data?: { first?: unknown, records?: unknown }[] }
  try {
    answer = await (await queryAnalyticsEngine(options, statement)).json() as typeof answer
  }
  catch (error) {
    throw new SeedUnavailable((error as Error)?.name ?? 'Error', error instanceof AnalyticsRequestError ? error.status : null)
  }
  const row = answer.data?.[0]
  const records = Number(row?.records)
  if (!row || !Number.isSafeInteger(records) || records < 0)
    throw new SeedUnavailable('bad_answer')
  if (records === 0)
    return null
  const first = Number(row.first)
  if (!Number.isSafeInteger(first) || first <= 0 || first > options.now / 1000)
    throw new SeedUnavailable('bad_answer')
  return first
}

/**
 * Inserts the steps of the eligible days, from the oldest record on, when the
 * newest day has no `totals` step: once a UTC day, and once for a table seeded
 * before the rollups existed. `INSERT OR IGNORE` keeps every step already
 * there. Steps of window days before the oldest record hold nothing, so any
 * still pending (seeded before this rule) are marked done without being asked
 * for. Days that already left the window are not touched: they read as
 * without data, never as zero. When the query fails, nothing is seeded, the
 * steps already seeded still run, and the next run asks again.
 */
async function seedSteps(env: Cloudflare.Env, db: Database, days: string[], options: AnalyticsExportOptions, now: number): Promise<void> {
  const newest = days.at(-1)!
  const [existing] = await db.select({ day: analyticsExportSteps.day }).from(analyticsExportSteps).where(and(eq(analyticsExportSteps.day, newest), eq(analyticsExportSteps.step, 'totals'))).limit(1)
  if (existing)
    return

  let firstRecord: number | null
  try {
    firstRecord = await firstRecordTime(options, days[0]!)
  }
  catch (error) {
    if (!(error instanceof SeedUnavailable))
      throw error
    console.warn({ event: 'analytics_export.seed_failed', reason: error.reason, status: error.status })
    return
  }
  const seeded = daysFromFirstRecord(days, firstRecord)

  // One insert, so the newest day's `totals` existing means every step does.
  // Budget rows older than the window are no longer read.
  const [, skipped] = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO analytics_export_steps (day, step) SELECT days.value, steps.value FROM json_each(?1) AS days, json_each(?2) AS steps')
      .bind(JSON.stringify(seeded), JSON.stringify(daySteps())),
    env.DB.prepare('UPDATE analytics_export_steps SET completed_at = ?, started_at = NULL WHERE day >= ? AND day < ? AND completed_at IS NULL AND parked_at IS NULL')
      .bind(now, days[0]!, seeded[0]!),
    env.DB.prepare('DELETE FROM analytics_export_budget WHERE utc_day < ?').bind(days[0]!),
  ])
  // Visible, so a wrong skip would show in the logs.
  if (skipped?.meta.changes)
    console.log({ event: 'analytics_export.skipped_before_first_record', firstDay: seeded[0], steps: skipped.meta.changes })
}

interface ClaimedStep { day: string, step: string, attempts: number, parked: boolean, nextKey: string | null }

/**
 * Claims the oldest pending step with one guarded update, so two overlapping
 * runs never take the same step. Taking back an expired claim counts an
 * attempt: the run that held it was killed, most likely for CPU. A step
 * already tried in this run is skipped, so a failure is retried on a later
 * run rather than three times in a row.
 *
 * Every pending archive hour comes before any rollup step, so a rollup query
 * that keeps failing can never hold up the archive.
 * ponytail: on a new install with three months of data, the archive catch-up
 * (about 2.5 days) comes first, and the oldest days age out before their
 * rollups run; their records stay in the R2 archive for an offline rebuild.
 */
async function claimNextStep(db: Database, oldestDay: string, now: number, tried: ClaimedStep[], rollupsAllowed: boolean): Promise<ClaimedStep | null> {
  const expired = now - CLAIM_TTL_SECONDS
  const pending = and(
    isNull(analyticsExportSteps.completedAt),
    isNull(analyticsExportSteps.parkedAt),
    or(isNull(analyticsExportSteps.startedAt), lt(analyticsExportSteps.startedAt, expired)),
  )
  const isArchive = like(analyticsExportSteps.step, 'archive:%')
  const [candidate] = await db.select()
    .from(analyticsExportSteps)
    .where(and(pending, gte(analyticsExportSteps.day, oldestDay), rollupsAllowed ? undefined : isArchive, ...tried.map(step => not(stepWhere(step)!))))
    .orderBy(drizzleSql`case when ${isArchive} then 0 else 1 end`, asc(analyticsExportSteps.day), asc(analyticsExportSteps.step))
    .limit(1)
  if (!candidate)
    return null

  const attempts = candidate.attempts + (candidate.startedAt === null ? 0 : 1)
  const parked = attempts >= MAX_ATTEMPTS
  const [claimed] = await db.update(analyticsExportSteps)
    .set({ attempts, startedAt: parked ? null : now, parkedAt: parked ? now : null })
    .where(and(
      eq(analyticsExportSteps.day, candidate.day),
      eq(analyticsExportSteps.step, candidate.step),
      eq(analyticsExportSteps.attempts, candidate.attempts),
      pending,
    ))
    .returning({ day: analyticsExportSteps.day, step: analyticsExportSteps.step })
  return claimed ? { ...claimed, attempts, parked, nextKey: candidate.nextKey } : null
}

function stepWhere(step: ClaimedStep) {
  return and(eq(analyticsExportSteps.day, step.day), eq(analyticsExportSteps.step, step.step))
}

/** The step, only while this run still holds its claim: a later run may have taken it back. */
function claimWhere(step: ClaimedStep, now: number) {
  return and(stepWhere(step), eq(analyticsExportSteps.startedAt, now))
}

function isMissingTable(error: unknown): boolean {
  const text = `${(error as Error)?.message ?? ''} ${((error as Error)?.cause as Error)?.message ?? ''}`
  return text.includes('no such table')
}

/** Logs only from the run in the first 5 minutes of the UTC day, so it appears once a day. */
function warnOncePerDay(now: number, entry: Record<string, unknown>) {
  if (now % DAY_MS < 5 * 60_000)
    console.warn(entry)
}

/** Today's rollup rows written and the database size, which decide whether rollup steps run. */
async function readBudget(env: Cloudflare.Env, now: number): Promise<{ rowsWritten: number, databaseBytes: number | null }> {
  const result = await env.DB.prepare('SELECT rows_written FROM analytics_export_budget WHERE utc_day = ?')
    .bind(new Date(now).toISOString().slice(0, 10))
    .all<{ rows_written: number }>()
  return { rowsWritten: result.results[0]?.rows_written ?? 0, databaseBytes: result.meta.size_after ?? null }
}

export async function runAnalyticsExport(env: Cloudflare.Env, options: AnalyticsExportOptions): Promise<AnalyticsExportSummary> {
  const summary: AnalyticsExportSummary = { stepsDone: 0, stepsFailed: 0, stepsParked: 0 }
  const stop = (reason: NonNullable<AnalyticsExportSummary['stopped']>) => {
    warnOncePerDay(options.now, { event: 'analytics_export.stopped', reason })
    return { ...summary, stopped: reason }
  }
  if (!options.accountId || !options.apiToken)
    return stop('not_configured')
  if (!env.R2)
    return stop('no_r2')

  const db = drizzle(env.DB)
  const now = Math.floor(options.now / 1000)
  const days = eligibleDays(options.now)
  let budget: Awaited<ReturnType<typeof readBudget>>
  try {
    await seedSteps(env, db, days, options, now)
    budget = await readBudget(env, options.now)
  }
  catch (error) {
    if (isMissingTable(error))
      return stop('not_migrated')
    throw error
  }
  // An unknown size counts as over the limit: the stop must not fail open.
  const overSize = budget.databaseBytes === null || budget.databaseBytes > (options.maxDatabaseBytes ?? MAX_DATABASE_BYTES)
  // Once an hour while it lasts: it does not end by itself.
  if (overSize && options.now % 3_600_000 < 5 * 60_000)
    console.warn({ event: 'analytics_export.size_limit', databaseBytes: budget.databaseBytes })

  const tried: ClaimedStep[] = []
  for (let run = 0; run < STEPS_PER_RUN; run++) {
    const step = await claimNextStep(db, days[0]!, now, tried, !overSize && budget.rowsWritten < ROLLUP_ROWS_PER_DAY)
    if (!step)
      break
    tried.push(step)
    if (step.parked) {
      summary.stepsParked++
      console.error({ event: 'analytics_export.step_parked', day: step.day, step: step.step, attempts: step.attempts, reason: 'claim_expired' })
      continue
    }

    try {
      if (step.step.startsWith('archive:')) {
        const { records, kept } = await archiveHour(env.R2, step.day, Number(step.step.slice('archive:'.length)), options)
        await db.update(analyticsExportSteps).set({ completedAt: now, startedAt: null }).where(claimWhere(step, now))
        if (kept < records)
          console.warn({ event: 'analytics_export.hour_truncated', day: step.day, step: step.step, records, kept })
      }
      else {
        const before = budget.rowsWritten
        budget.rowsWritten += await runRollupStep(env, step, options, now)
        // Logged by the step that crosses the budget, so once per UTC day.
        if (before < ROLLUP_ROWS_PER_DAY && budget.rowsWritten >= ROLLUP_ROWS_PER_DAY)
          console.warn({ event: 'analytics_export.write_budget', rowsWritten: budget.rowsWritten })
      }
      summary.stepsDone++
    }
    catch (error) {
      if (!(error instanceof StepError)) {
        // ponytail: a failure only one hour ever hits stops every run at that hour
        // until it ages out of the window; the log names it. Add a per-step stop
        // counter if `stopped` logs keep naming the same hour.
        await db.update(analyticsExportSteps).set({ startedAt: null }).where(claimWhere(step, now))
        // Only the status code and error name: the message of a network error can carry anything.
        console.warn({ event: 'analytics_export.stopped', reason: 'analytics_unavailable', day: step.day, step: step.step, status: (error as { status?: number }).status ?? null, errorName: (error as Error)?.name ?? null })
        console.log({ event: 'analytics_export.run', ...summary, stopped: 'analytics_unavailable' })
        return { ...summary, stopped: 'analytics_unavailable' }
      }
      const attempts = step.attempts + 1
      const parked = attempts >= MAX_ATTEMPTS
      await db.update(analyticsExportSteps).set({ attempts, startedAt: null, parkedAt: parked ? now : null }).where(claimWhere(step, now))
      const entry = { day: step.day, step: step.step, attempts, reason: error.reason }
      if (parked) {
        summary.stepsParked++
        console.error({ event: 'analytics_export.step_parked', ...entry })
      }
      else {
        summary.stepsFailed++
        console.warn({ event: 'analytics_export.step_failed', ...entry })
      }
    }
  }

  if (summary.stepsDone || summary.stepsFailed || summary.stepsParked)
    console.log({ event: 'analytics_export.run', ...summary })
  return summary
}
