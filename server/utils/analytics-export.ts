import { and, asc, eq, gte, isNull, lt, not, or } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { sql } from 'kysely'
import { analyticsExportSteps } from '../database/schema'
import { blobsMap, doublesMap } from './access-log'
import { compileAnalyticsQuery, createAnalyticsQuery } from './analytics-sql'
import { uploadBackupParts } from './backup-json-stream'

/**
 * Copies every Analytics Engine record into R2, one file per UTC hour, before
 * Analytics Engine deletes it after about three months.
 *
 * It runs on a 5-minute cron trigger. On the free plan one run gets 10 ms of
 * CPU, so a run does at most a few steps, and a step mostly waits on the
 * network: the records are streamed into R2 without being parsed.
 */

export const ARCHIVE_PREFIX = 'analytics/raw/'
/** Days younger than this may still receive late records. */
const MIN_AGE_DAYS = 2
/** A few days' margin inside Analytics Engine's three months (89 to 92 days). */
const MAX_AGE_DAYS = 85
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
const ROWS_PER_SEED_STATEMENT = 48

export interface AnalyticsExportOptions {
  accountId: string
  apiToken: string
  dataset: string
  /** Milliseconds; the cron run's scheduled time. */
  now: number
}

export interface AnalyticsExportSummary {
  stepsDone: number
  stepsFailed: number
  stepsParked: number
  stopped?: 'not_configured' | 'no_r2' | 'not_migrated' | 'analytics_unavailable'
}

/** Full UTC days from 85 to 2 days old, oldest first, as `YYYY-MM-DD`. */
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

type Database = ReturnType<typeof drizzle>

/** Inserts the steps of every eligible day once, when the newest day is missing. */
async function seedSteps(env: Cloudflare.Env, db: Database, days: string[]): Promise<void> {
  const newest = days.at(-1)!
  const [existing] = await db.select({ day: analyticsExportSteps.day }).from(analyticsExportSteps).where(eq(analyticsExportSteps.day, newest)).limit(1)
  if (existing)
    return

  // Oldest first, so the newest day existing means every older day does too.
  const rows = days.flatMap(day => Array.from({ length: 24 }, (_, hour) => [day, `archive:${String(hour).padStart(2, '0')}`]))
  const statements: D1PreparedStatement[] = []
  for (let offset = 0; offset < rows.length; offset += ROWS_PER_SEED_STATEMENT) {
    const chunk = rows.slice(offset, offset + ROWS_PER_SEED_STATEMENT)
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO analytics_export_steps (day, step) VALUES ${chunk.map(() => '(?, ?)').join(', ')}`).bind(...chunk.flat()))
  }
  await env.DB.batch(statements)
}

interface ClaimedStep { day: string, step: string, attempts: number, parked: boolean }

/**
 * Claims the oldest pending step with one guarded update, so two overlapping
 * runs never take the same step. Taking back an expired claim counts an
 * attempt: the run that held it was killed, most likely for CPU. A step
 * already tried in this run is skipped, so a failure is retried on a later
 * run rather than three times in a row.
 */
async function claimNextStep(db: Database, oldestDay: string, now: number, tried: ClaimedStep[]): Promise<ClaimedStep | null> {
  const expired = now - CLAIM_TTL_SECONDS
  const pending = and(
    isNull(analyticsExportSteps.completedAt),
    isNull(analyticsExportSteps.parkedAt),
    or(isNull(analyticsExportSteps.startedAt), lt(analyticsExportSteps.startedAt, expired)),
  )
  const [candidate] = await db.select().from(analyticsExportSteps).where(and(pending, gte(analyticsExportSteps.day, oldestDay), ...tried.map(step => not(stepWhere(step)!)))).orderBy(asc(analyticsExportSteps.day), asc(analyticsExportSteps.step)).limit(1)
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
  return claimed ? { ...claimed, attempts, parked } : null
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

/** Logs a stop reason only from the run in the first 5 minutes of the UTC day, so it appears once a day. */
function logStopOncePerDay(now: number, reason: string) {
  if (now % DAY_MS < 5 * 60_000)
    console.warn({ event: 'analytics_export.stopped', reason })
}

export async function runAnalyticsExport(env: Cloudflare.Env, options: AnalyticsExportOptions): Promise<AnalyticsExportSummary> {
  const summary: AnalyticsExportSummary = { stepsDone: 0, stepsFailed: 0, stepsParked: 0 }
  const stop = (reason: NonNullable<AnalyticsExportSummary['stopped']>) => {
    logStopOncePerDay(options.now, reason)
    return { ...summary, stopped: reason }
  }
  if (!options.accountId || !options.apiToken)
    return stop('not_configured')
  if (!env.R2)
    return stop('no_r2')

  const db = drizzle(env.DB)
  const now = Math.floor(options.now / 1000)
  const days = eligibleDays(options.now)
  try {
    await seedSteps(env, db, days)
  }
  catch (error) {
    if (isMissingTable(error))
      return stop('not_migrated')
    throw error
  }

  const tried: ClaimedStep[] = []
  for (let run = 0; run < STEPS_PER_RUN; run++) {
    const step = await claimNextStep(db, days[0]!, now, tried)
    if (!step)
      break
    tried.push(step)
    if (step.parked) {
      summary.stepsParked++
      console.error({ event: 'analytics_export.step_parked', day: step.day, step: step.step, attempts: step.attempts, reason: 'claim_expired' })
      continue
    }

    try {
      const { records, kept } = await archiveHour(env.R2, step.day, Number(step.step.slice('archive:'.length)), options)
      await db.update(analyticsExportSteps).set({ completedAt: now, startedAt: null }).where(claimWhere(step, now))
      summary.stepsDone++
      if (kept < records)
        console.warn({ event: 'analytics_export.hour_truncated', day: step.day, step: step.step, records, kept })
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
