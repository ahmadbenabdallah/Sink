import { env } from 'cloudflare:workers'
import { and, eq, gte, isNull, like, lt, not } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyticsDaily, analyticsDailyBreakdown, analyticsExportBudget, analyticsExportSteps } from '../../server/database/schema'
import { archiveKey, hourWindow, runAnalyticsExport } from '../../server/utils/analytics-export'
import { ANALYTICS_EXPORT_CRON } from '../../server/utils/cron'
import wranglerConfig from '../../wrangler.jsonc?raw'
import { db, runScheduledTasks } from '../utils'

vi.mock('#shared/utils/flag', () => ({ getFlag: vi.fn() }))

const NOW = Date.UTC(2026, 10, 14, 0, 2) // 2026-11-14 00:02 UTC
const OLDEST = '2026-08-16' // 90 days before NOW
const NEWEST = '2026-11-12' // 2 days before NOW
const ACCOUNT = 'test-account-id-4f1c'
const TOKEN = 'test-api-token-9a7e'
const options = { accountId: ACCOUNT, apiToken: TOKEN, dataset: 'sink', now: NOW }
const DAY_MS = 86_400_000
const encoder = new TextEncoder()

type Answer = { status: number, body?: string } | Error

/** Analytics Engine answers by hour start: rows for an hour, or a failure. */
let hours: Map<number, string[] | Answer>
let fetchSpy: ReturnType<typeof vi.spyOn>
/** The UTC day of the oldest record Analytics Engine holds, or null for none; OLDEST by default. */
let firstRecordDay: string | null

/** Answers the "oldest record" query that seeding asks first; null for any other query. */
function answerFirstRecord(sql: string): Response | null {
  if (!sql.includes('min(timestamp)'))
    return null
  return Response.json({ data: [firstRecordDay === null ? { first: '0', records: '0' } : { first: String(Date.parse(`${firstRecordDay}T10:00:00Z`) / 1000), records: '12' }] })
}
/** Answers the rollup queries (the ones with `group by`); every day has no rows by default. */
let rollupAnswer: (sql: string) => Response | Promise<Response>

/** One UTC day as [start, end) in unix seconds. */
function dayStart(day: string) {
  return Date.parse(`${day}T00:00:00Z`) / 1000
}

function lines(rows: object[]) {
  return new Response(rows.map(row => `${JSON.stringify(row)}\n`).join(''))
}

function ndjson(count: number, hourStart: number) {
  return Array.from({ length: count }, (_, i) => JSON.stringify({ timestamp: new Date((hourStart + i) * 1000).toISOString(), _sample_interval: 1, index1: `id-${i}`, slug: `s${i}` }))
}

/** Analytics Engine calls, without the "oldest record" query seeding asks once a day. */
function analyticsCalls() {
  return fetchSpy.mock.calls.filter(([input, init]) => String(input instanceof Request ? input.url : input).includes('/analytics_engine/sql') && !String(init?.body).includes('min(timestamp)'))
}

function stubAnalyticsEngine() {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`))
      throw new Error(`Unexpected outbound request to ${url}`)
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`)
    const sql = String(init?.body)
    const first = answerFirstRecord(sql)
    if (first)
      return first
    if (sql.includes(' group by '))
      return rollupAnswer(sql)
    const start = Number(/toDateTime\((\d+)\)/.exec(sql)?.[1])
    const answer = hours.get(start) ?? []
    if (answer instanceof Error)
      throw answer
    if (!Array.isArray(answer))
      return new Response(answer.body ?? 'error', { status: answer.status })
    if (sql.includes('count()'))
      return Response.json({ data: [{ records: String(answer.length) }], rows: 1 })
    return new Response(answer.map(line => `${line}\n`).join(''), { headers: { 'Content-Type': 'application/x-ndjson' } })
  })
}

/** Answers the count and the records query for the oldest day's hour 0; every other hour is empty. */
function stubFirstHour(records: string, raw: (sql: string) => Response | Promise<Response>) {
  const start = hourWindow(OLDEST, 0).start
  fetchSpy.mockImplementation(async (_input, init) => {
    const sql = String(init?.body)
    const first = answerFirstRecord(sql)
    if (first)
      return first
    if (sql.includes(' group by '))
      return rollupAnswer(sql)
    if (!sql.includes(`toDateTime(${start})`))
      return Response.json({ data: [{ records: '0' }], rows: 1 })
    if (sql.includes('count()'))
      return Response.json({ data: [{ records }], rows: 1 })
    return raw(sql)
  })
}

async function stepRow(day: string, hour: number) {
  const [row] = await db.select().from(analyticsExportSteps).where(and(eq(analyticsExportSteps.day, day), eq(analyticsExportSteps.step, `archive:${String(hour).padStart(2, '0')}`)))
  return row
}

async function deleteArchive() {
  let cursor: string | undefined
  do {
    const page = await env.R2.list({ prefix: 'analytics/raw/', cursor })
    await Promise.all(page.objects.map(object => env.R2.delete(object.key)))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}

async function clearTables() {
  await db.delete(analyticsExportSteps)
  await db.delete(analyticsDaily)
  await db.delete(analyticsDailyBreakdown)
  await db.delete(analyticsExportBudget)
}

beforeEach(async () => {
  hours = new Map()
  firstRecordDay = OLDEST
  rollupAnswer = () => new Response('')
  stubAnalyticsEngine()
  await clearTables()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await clearTables()
  await deleteArchive()
})

describe('analytics archive', { concurrent: false }, () => {
  it('archives the oldest day first, three hours per run, writing each hour byte for byte', async () => {
    const first = hourWindow(OLDEST, 0).start
    hours.set(first, ndjson(4, first))

    const summary = await runAnalyticsExport(env, options)

    expect(summary).toMatchObject({ stepsDone: 3 })
    const object = await env.R2.get(archiveKey(OLDEST, 0))
    expect(await object?.text()).toBe(`${ndjson(4, first).join('\n')}\n`)
    const raw = analyticsCalls().map(([, init]) => String(init?.body)).filter(sql => sql.includes('FORMAT'))
    expect(raw[0]).toBe(`select timestamp, _sample_interval, index1, blob1 as slug, blob2 as url, blob3 as ua, blob4 as ip, blob5 as referer, blob6 as country, blob7 as region, blob8 as city, blob9 as timezone, blob10 as language, blob11 as os, blob12 as browser, blob13 as browserType, blob14 as device, blob15 as deviceType, blob16 as COLO, double1 as latitude, double2 as longitude from sink where timestamp >= toDateTime(${first}) and timestamp < toDateTime(${first + 3600}) order by timestamp limit 4 FORMAT JSONEachRow`)
    // Empty hours are done without a file.
    expect(await env.R2.head(archiveKey(OLDEST, 1))).toBeNull()
    for (const hour of [0, 1, 2])
      expect((await stepRow(OLDEST, hour))?.completedAt).toEqual(expect.any(Number))
    expect((await stepRow(OLDEST, 3))?.completedAt).toBeNull()

    await runAnalyticsExport(env, options)
    expect((await stepRow(OLDEST, 3))?.completedAt).toEqual(expect.any(Number))
  })

  it('seeds every step of every day from 90 to 2 days old when the records go back that far', async () => {
    await runAnalyticsExport(env, options)

    const rows = await db.select({ day: analyticsExportSteps.day }).from(analyticsExportSteps)
    const days = [...new Set(rows.map(row => row.day))].sort()
    expect(days[0]).toBe(OLDEST)
    expect(days.at(-1)).toBe(NEWEST)
    expect(rows).toHaveLength(89 * 37)
  })

  it('adds only the 37 steps of the newly eligible day on the next UTC day', async () => {
    await runAnalyticsExport(env, options)
    await runAnalyticsExport(env, { ...options, now: NOW + DAY_MS })

    const rows = await db.select({ day: analyticsExportSteps.day }).from(analyticsExportSteps)
    expect(rows).toHaveLength(90 * 37)
    expect(rows.filter(row => row.day === '2026-11-13')).toHaveLength(37)
  })

  it('seeds only from the day of the oldest record Analytics Engine holds, and archives that day first', async () => {
    firstRecordDay = '2026-11-09'
    const start = hourWindow('2026-11-09', 0).start
    hours.set(start, ndjson(2, start))

    await runAnalyticsExport(env, options)

    const days = [...new Set((await db.select({ day: analyticsExportSteps.day }).from(analyticsExportSteps)).map(row => row.day))].sort()
    expect(days).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'])
    expect(await (await env.R2.get(archiveKey('2026-11-09', 0)))?.text()).toBe(`${ndjson(2, start).join('\n')}\n`)
  })

  it('marks the steps of days before the oldest record done without asking for them', async () => {
    // Seeded before this feature, from the start of the window.
    await runAnalyticsExport(env, options)
    await db.update(analyticsExportSteps).set({ completedAt: null })
    firstRecordDay = '2026-11-10'
    const before = analyticsCalls().length
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})

    // The next UTC day seeds again, now from the oldest record.
    await runAnalyticsExport(env, { ...options, now: NOW + DAY_MS })

    // Only days inside the window: Analytics Engine vouches for them having no record.
    const pendingBefore = await db.select().from(analyticsExportSteps).where(and(gte(analyticsExportSteps.day, '2026-08-17'), lt(analyticsExportSteps.day, '2026-11-10'), isNull(analyticsExportSteps.completedAt)))
    expect(pendingBefore).toHaveLength(0)
    // A day that has aged out of the window stays as it was: it reads as without data, never as zero.
    expect(await db.select().from(analyticsExportSteps).where(and(eq(analyticsExportSteps.day, OLDEST), isNull(analyticsExportSteps.completedAt)))).toHaveLength(37)
    expect(logs.mock.calls.map(([entry]) => entry)).toContainEqual({ event: 'analytics_export.skipped_before_first_record', firstDay: '2026-11-10', steps: expect.any(Number) })
    const sqls = analyticsCalls().slice(before).map(([, init]) => String(init?.body))
    expect(sqls[0]).toContain(`toDateTime(${hourWindow('2026-11-10', 0).start})`)
  })

  it('seeds only the newest day when Analytics Engine holds no record', async () => {
    firstRecordDay = null

    await runAnalyticsExport(env, options)

    const days = [...new Set((await db.select({ day: analyticsExportSteps.day }).from(analyticsExportSteps)).map(row => row.day))]
    expect(days).toEqual([NEWEST])
  })

  it('seeds nothing when the oldest-record query fails, logging the status', async () => {
    fetchSpy.mockImplementation(async () => new Response('error', { status: 401 }))
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const summary = await runAnalyticsExport(env, options)

    expect(summary).toMatchObject({ stepsDone: 0 })
    expect(await db.select().from(analyticsExportSteps)).toHaveLength(0)
    expect(warns.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({ event: 'analytics_export.seed_failed', status: 401 }))
  })

  // Seeding needs Analytics Engine; the steps already seeded must not wait for it.
  it('still runs the steps already seeded when the oldest-record query fails', async () => {
    await runAnalyticsExport(env, options)
    await db.update(analyticsExportSteps).set({ completedAt: null })
    await db.delete(analyticsExportSteps).where(eq(analyticsExportSteps.day, NEWEST))
    vi.mocked(globalThis.fetch).mockImplementation(async (_input, init) => {
      const sql = String(init?.body)
      return sql.includes('min(timestamp)') ? Response.json({}) : Response.json({ data: [{ records: '0' }], rows: 1 })
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const summary = await runAnalyticsExport(env, options)

    expect(summary).toMatchObject({ stepsDone: 3 })
    expect(await db.select().from(analyticsExportSteps).where(eq(analyticsExportSteps.day, NEWEST))).toHaveLength(0)
  })

  // A wrong answer must never read as "no records": that would mark every earlier day done.
  it.each([
    ['no data', {}],
    ['an empty data list', { data: [] }],
    ['records that are not a number', { data: [{ first: '1794000000', records: 'many' }] }],
    ['records without a first time', { data: [{ first: '0', records: '5' }] }],
    ['a first time in the future', { data: [{ first: '100000000000000000000', records: '5' }] }],
  ])('seeds nothing on an answer with %s', async (_label, answer) => {
    fetchSpy.mockImplementation(async () => Response.json(answer))
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const summary = await runAnalyticsExport(env, options)

    expect(summary).toMatchObject({ stepsDone: 0 })
    expect(await db.select().from(analyticsExportSteps)).toHaveLength(0)
    expect(warns.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({ event: 'analytics_export.seed_failed', reason: 'bad_answer' }))
  })

  it('asks for the oldest record within the window only', async () => {
    const sqls: string[] = []
    fetchSpy.mockImplementation(async (_input, init) => {
      sqls.push(String(init?.body))
      return answerFirstRecord(String(init?.body)) ?? Response.json({ data: [{ records: '0' }], rows: 1 })
    })

    await runAnalyticsExport(env, options)

    expect(sqls.find(sql => sql.includes('min(timestamp)'))).toBe(`select toUnixTimestamp(min(timestamp)) as first, count() as records from sink where timestamp >= toDateTime(${Date.UTC(2026, 7, 16) / 1000})`)
  })

  it('never fetches an hour that is already done', async () => {
    await runAnalyticsExport(env, options)
    const before = analyticsCalls().length
    await db.update(analyticsExportSteps).set({ completedAt: 1 }).where(eq(analyticsExportSteps.day, OLDEST))

    await runAnalyticsExport(env, options)

    const sqls = analyticsCalls().slice(before).map(([, init]) => String(init?.body))
    expect(sqls.every(sql => !sql.includes(`toDateTime(${hourWindow(OLDEST, 3).start})`))).toBe(true)
  })

  for (const [name, answer] of [
    ['401', { status: 401 }],
    ['429', { status: 429 }],
    ['500', { status: 500 }],
    ['400, which every hour would hit', { status: 400 }],
    ['a network error', new TypeError('fetch failed')],
    ['a workerd network error', new Error('Network connection lost.')],
  ] as [string, Answer][]) {
    it(`stops the run on ${name} without counting an attempt`, async () => {
      hours.set(hourWindow(OLDEST, 0).start, answer)

      const summary = await runAnalyticsExport(env, options)

      expect(summary).toMatchObject({ stepsDone: 0, stopped: 'analytics_unavailable' })
      expect(analyticsCalls()).toHaveLength(1)
      expect(await stepRow(OLDEST, 0)).toMatchObject({ attempts: 0, startedAt: null, completedAt: null, parkedAt: null })
    })
  }

  for (const status of [400, 403, 503]) {
    it(`stops the run without counting an attempt when the records query answers ${status}, naming the hour`, async () => {
      stubFirstHour('2', () => new Response('error', { status }))
      const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const summary = await runAnalyticsExport(env, options)

      expect(summary).toMatchObject({ stepsDone: 0, stopped: 'analytics_unavailable' })
      expect(await stepRow(OLDEST, 0)).toMatchObject({ attempts: 0, startedAt: null, completedAt: null, parkedAt: null })
      expect(await env.R2.head(archiveKey(OLDEST, 0))).toBeNull()
      expect(warns.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({ event: 'analytics_export.stopped', status, day: OLDEST, step: 'archive:00' }))
    })
  }

  it('aborts the upload, keeps no file and counts no attempt when the records stream breaks', async () => {
    const [line] = ndjson(1, hourWindow(OLDEST, 0).start)
    stubFirstHour('2', () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${line}\n`))
        controller.error(new Error('Network connection lost.'))
      },
    })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const summary = await runAnalyticsExport(env, options)

    expect(summary).toMatchObject({ stopped: 'analytics_unavailable' })
    expect(await stepRow(OLDEST, 0)).toMatchObject({ attempts: 0, completedAt: null })
    expect(await env.R2.head(archiveKey(OLDEST, 0))).toBeNull()
  })

  it('leaves the step alone when another run took it back while this run was still working', async () => {
    const [line] = ndjson(1, hourWindow(OLDEST, 0).start)
    stubFirstHour('1', async () => {
      // A second run took back the claim after it expired.
      await db.update(analyticsExportSteps).set({ attempts: 1, startedAt: 123 }).where(and(eq(analyticsExportSteps.day, OLDEST), eq(analyticsExportSteps.step, 'archive:00')))
      return new Response(`${line}\n`)
    })

    await runAnalyticsExport(env, options)

    expect(await stepRow(OLDEST, 0)).toMatchObject({ attempts: 1, startedAt: 123, completedAt: null })
  })

  it('keeps the file and counts an attempt when the line count differs, then parks the hour after 3', async () => {
    const start = hourWindow(OLDEST, 0).start
    const lines = ndjson(5, start)
    hours.set(start, lines)
    // The count says 5, but the raw answer is cut off after 3 lines.
    fetchSpy.mockImplementation(async (_input, init) => {
      const sql = String(init?.body)
      const first = answerFirstRecord(sql)
      if (first)
        return first
      if (!sql.includes(`toDateTime(${start})`))
        return Response.json({ data: [{ records: '0' }], rows: 1 })
      if (sql.includes('count()'))
        return Response.json({ data: [{ records: '5' }], rows: 1 })
      return new Response(lines.slice(0, 3).map(line => `${line}\n`).join(''))
    })
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runAnalyticsExport(env, options)
    // A failed hour is not retried in the same run.
    expect((await stepRow(OLDEST, 0))?.attempts).toBe(1)
    for (let run = 1; run < 3; run++)
      await runAnalyticsExport(env, options)

    expect(await stepRow(OLDEST, 0)).toMatchObject({ attempts: 3, completedAt: null, parkedAt: expect.any(Number) })
    expect(await (await env.R2.get(archiveKey(OLDEST, 0)))?.text()).toBe(`${lines.slice(0, 3).join('\n')}\n`)
    expect(logs.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({ event: 'analytics_export.step_parked', day: OLDEST, step: 'archive:00' }))
    // The parked hour no longer blocks the rest of the day.
    expect((await stepRow(OLDEST, 1))?.completedAt).toEqual(expect.any(Number))
  })

  it('keeps the first 10,000 records of an hour over the cap, marks it done and logs it', async () => {
    const lines = ndjson(10_000, hourWindow(OLDEST, 0).start)
    const raw: string[] = []
    stubFirstHour('10001', (sql) => {
      raw.push(sql)
      return new Response(lines.map(line => `${line}\n`).join(''))
    })
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runAnalyticsExport(env, options)

    expect(raw[0]).toContain('limit 10000 FORMAT JSONEachRow')
    expect(await stepRow(OLDEST, 0)).toMatchObject({ attempts: 0, completedAt: expect.any(Number), parkedAt: null })
    expect((await (await env.R2.get(archiveKey(OLDEST, 0)))?.text())?.split('\n')).toHaveLength(10_001)
    expect(warns.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({ event: 'analytics_export.hour_truncated', day: OLDEST, step: 'archive:00', records: 10_001, kept: 10_000 }))
  })

  it('takes back a claim older than 15 minutes as a failed attempt, and leaves a fresh claim alone', async () => {
    await runAnalyticsExport(env, { ...options, now: NOW - 3_600_000 })
    await db.delete(analyticsExportSteps).where(eq(analyticsExportSteps.day, OLDEST))
    await db.insert(analyticsExportSteps).values([
      { day: OLDEST, step: 'archive:00', attempts: 0, startedAt: NOW / 1000 - 16 * 60 },
      { day: OLDEST, step: 'archive:01', attempts: 0, startedAt: NOW / 1000 - 60 },
    ])

    await runAnalyticsExport(env, options)

    expect(await stepRow(OLDEST, 0)).toMatchObject({ attempts: 1, completedAt: expect.any(Number) })
    expect(await stepRow(OLDEST, 1)).toMatchObject({ attempts: 0, completedAt: null })
  })

  it('does nothing without an account id or API token', async () => {
    for (const missing of [{ accountId: '' }, { apiToken: '' }]) {
      const summary = await runAnalyticsExport(env, { ...options, ...missing })
      expect(summary).toMatchObject({ stepsDone: 0, stopped: 'not_configured' })
    }
    expect(analyticsCalls()).toHaveLength(0)
    expect(await db.select().from(analyticsExportSteps)).toHaveLength(0)
  })

  it('does nothing without an R2 binding', async () => {
    const { R2: _r2, ...withoutR2 } = env
    const summary = await runAnalyticsExport(withoutR2 as Cloudflare.Env, options)

    expect(summary).toMatchObject({ stepsDone: 0, stopped: 'no_r2' })
    expect(analyticsCalls()).toHaveLength(0)
  })

  it('never writes the API token or the account id to a log', async () => {
    hours.set(hourWindow(OLDEST, 0).start, { status: 500, body: `failed for ${ACCOUNT}` })
    const lines: unknown[] = []
    for (const method of ['log', 'info', 'warn', 'error'] as const)
      vi.spyOn(console, method).mockImplementation((...args) => void lines.push(...args))

    await runAnalyticsExport(env, options)
    hours.set(hourWindow(OLDEST, 0).start, new TypeError(`fetch failed ${TOKEN}`))
    await runAnalyticsExport(env, options)

    const text = JSON.stringify(lines)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(ACCOUNT)
  })
})

async function rollupStep(day: string, step: string) {
  const [row] = await db.select().from(analyticsExportSteps).where(and(eq(analyticsExportSteps.day, day), eq(analyticsExportSteps.step, step)))
  return row
}

describe('analytics rollups', { concurrent: false }, () => {
  beforeEach(async () => {
    // Seed the steps once with a run that does nothing else.
    fetchSpy.mockImplementation(async (_input, init) => answerFirstRecord(String(init?.body)) ?? Response.json({ data: [{ records: '0' }], rows: 1 }))
    await runAnalyticsExport(env, options)
    stubAnalyticsEngine()
    fetchSpy.mockClear()
    await db.update(analyticsExportSteps).set({ completedAt: null, startedAt: null, attempts: 0, parkedAt: null, nextKey: null })
  })

  async function leave(...steps: { day: string, step: string }[]) {
    await db.update(analyticsExportSteps).set({ completedAt: 1 })
    for (const { day, step } of steps)
      await db.update(analyticsExportSteps).set({ completedAt: null }).where(and(eq(analyticsExportSteps.day, day), eq(analyticsExportSteps.step, step)))
  }

  it('gives a table seeded before the rollups existed the 13 rollup steps of every day, once', async () => {
    await db.delete(analyticsExportSteps).where(not(like(analyticsExportSteps.step, 'archive:%')))
    await db.update(analyticsExportSteps).set({ completedAt: 7 }).where(eq(analyticsExportSteps.step, 'archive:05'))
    await db.insert(analyticsExportBudget).values([{ utcDay: '2026-08-01', rowsWritten: 9 }, { utcDay: '2026-11-13', rowsWritten: 9 }])
    const batches = vi.spyOn(env.DB, 'batch')

    await runAnalyticsExport(env, options)
    await runAnalyticsExport(env, options)

    // The free plan allows 50 D1 queries per invocation; no batch comes near it.
    expect(Math.max(...batches.mock.calls.map(([statements]) => statements.length))).toBeLessThanOrEqual(3)
    // Budget rows older than the window are deleted.
    expect((await db.select().from(analyticsExportBudget)).map(row => row.utcDay)).toEqual(['2026-11-13'])

    const rows = await db.select().from(analyticsExportSteps)
    expect(rows).toHaveLength(89 * 37)
    expect(rows.filter(row => row.day === OLDEST).map(row => row.step).filter(step => !step.startsWith('archive:')).sort()).toEqual([
      'breakdown:COLO',
      'breakdown:browser',
      'breakdown:browserType',
      'breakdown:city',
      'breakdown:country',
      'breakdown:device',
      'breakdown:deviceType',
      'breakdown:language',
      'breakdown:os',
      'breakdown:referer',
      'breakdown:region',
      'breakdown:timezone',
      'totals',
    ])
    // Archive progress is kept.
    expect(rows.filter(row => row.step === 'archive:05').every(row => row.completedAt === 7)).toBe(true)
  })

  it('takes every pending archive hour before any rollup step', async () => {
    await leave({ day: OLDEST, step: 'totals' }, { day: NEWEST, step: 'archive:23' })

    await runAnalyticsExport(env, options)

    const sqls = analyticsCalls().map(([, init]) => String(init?.body))
    expect(sqls[0]).toContain(`toDateTime(${hourWindow(NEWEST, 23).start})`)
    expect(sqls[0]).toContain('count()')
  })

  it('pages the day\'s totals per link, 500 links per run of the step, resuming after the last link id', async () => {
    await leave({ day: OLDEST, step: 'totals' })
    const all = Array.from({ length: 1200 }, (_, i) => ({ link_id: `id-${String(i).padStart(4, '0')}`, slug: `s${i}`, visits: 1, visitors: 1, referers: 0 }))
    const sqls: string[] = []
    rollupAnswer = (sql) => {
      sqls.push(sql)
      const after = /and index1 > '([^']*)' group by/.exec(sql)
      const from = after ? all.findIndex(row => row.link_id === after[1]) + 1 : 0
      return lines(all.slice(from, from + 500))
    }

    for (const expected of [500, 1000, 1200]) {
      await runAnalyticsExport(env, options)
      expect(await db.select().from(analyticsDaily)).toHaveLength(expected)
    }

    expect(sqls[1]).toContain(`and index1 > 'id-0499' group by`)
    expect(sqls).toHaveLength(3)
    expect((await rollupStep(OLDEST, 'totals'))?.completedAt).toEqual(expect.any(Number))
  })

  it('writes the day\'s totals per link with the card formulas, and the same rows when run again', async () => {
    await leave({ day: OLDEST, step: 'totals' })
    const sqls: string[] = []
    rollupAnswer = (sql) => {
      sqls.push(sql)
      return lines([
        { link_id: 'id-a', slug: 'a', visits: '12', visitors: 5, referers: 2 },
        { link_id: 'id-b', slug: 'b', visits: '3', visitors: 3, referers: 0 },
      ])
    }

    await runAnalyticsExport(env, options)
    await leave({ day: OLDEST, step: 'totals' })
    await runAnalyticsExport(env, options)

    const start = dayStart(OLDEST)
    expect(sqls[0]).toBe(`select index1 as link_id, max(blob1) as slug, SUM(_sample_interval) as visits, ROUND(COUNT(DISTINCT blob4) * SUM(_sample_interval) / COUNT()) as visitors, ROUND(COUNT(DISTINCT blob5) * SUM(_sample_interval) / COUNT()) as referers from sink where timestamp >= toDateTime(${start}) and timestamp < toDateTime(${start + 86_400}) group by index1 order by index1 limit 500 FORMAT JSONEachRow`)
    expect(await db.select().from(analyticsDaily).orderBy(analyticsDaily.linkId)).toEqual([
      { day: OLDEST, linkId: 'id-a', slug: 'a', visits: 12, visitors: 5, referers: 2 },
      { day: OLDEST, linkId: 'id-b', slug: 'b', visits: 3, visitors: 3, referers: 0 },
    ])
    expect((await rollupStep(OLDEST, 'totals'))?.completedAt).toEqual(expect.any(Number))
    // The rows written are counted against today's budget.
    expect(await db.select().from(analyticsExportBudget)).toEqual([{ utcDay: '2026-11-14', rowsWritten: 4, rowsRead: 0 }])
  })

  it('pages a breakdown 500 rows per run of the step, resuming after the last key, until a short page', async () => {
    await leave({ day: OLDEST, step: 'breakdown:referer' })
    const all = Array.from({ length: 1200 }, (_, i) => ({ link_id: `id-${String(Math.floor(i / 100)).padStart(2, '0')}`, value: `host-${String(i % 100).padStart(3, '0')}.example`, visits: 2, visitors: 1 }))
    const sqls: string[] = []
    rollupAnswer = (sql) => {
      sqls.push(sql)
      const after = /index1 > '([^']*)' or \(index1 = '[^']*' and blob5 > '([^']*)'\)/.exec(sql)
      const from = after ? all.findIndex(row => row.link_id === after[1] && row.value === after[2]) + 1 : 0
      return lines(all.slice(from, from + 500))
    }

    const batches = vi.spyOn(env.DB, 'batch')

    for (const expected of [500, 1000, 1200]) {
      await runAnalyticsExport(env, options)
      expect(await db.select().from(analyticsDailyBreakdown)).toHaveLength(expected)
    }

    // A full page is still one statement.
    expect(Math.max(...batches.mock.calls.map(([statements]) => statements.length))).toBeLessThanOrEqual(3)

    const start = dayStart(OLDEST)
    expect(sqls[0]).toBe(`select index1 as link_id, blob5 as value, SUM(_sample_interval) as visits, ROUND(COUNT(DISTINCT blob4) * SUM(_sample_interval) / COUNT()) as visitors from sink where timestamp >= toDateTime(${start}) and timestamp < toDateTime(${start + 86_400}) group by index1, blob5 order by index1, blob5 limit 500 FORMAT JSONEachRow`)
    expect(sqls[1]).toContain(`and (index1 > 'id-04' or (index1 = 'id-04' and blob5 > 'host-099.example')) group by`)
    expect(sqls).toHaveLength(3)
    expect(await rollupStep(OLDEST, 'breakdown:referer')).toMatchObject({ completedAt: expect.any(Number), attempts: 0 })
    const [row] = await db.select().from(analyticsDailyBreakdown).where(eq(analyticsDailyBreakdown.value, 'host-007.example')).limit(1)
    expect(row).toMatchObject({ dimension: 'referer', day: OLDEST, visits: 2, visitors: 1 })
  })

  it('escapes visitor-controlled values in the resume key', async () => {
    await leave({ day: OLDEST, step: 'breakdown:referer' })
    const sqls: string[] = []
    rollupAnswer = (sql) => {
      sqls.push(sql)
      return lines(sqls.length === 1 ? Array.from({ length: 500 }, (_, i) => ({ link_id: 'id-a', value: i === 499 ? `it's \\ ${i}` : `v${String(i).padStart(3, '0')}`, visits: 1, visitors: 1 })) : [])
    }

    await runAnalyticsExport(env, options)
    await runAnalyticsExport(env, options)

    expect(sqls[1]).toContain(`blob5 > 'it''s \\\\ 499'`)
  })

  it('stops the run without counting an attempt when a rollup query fails for every step', async () => {
    await leave({ day: OLDEST, step: 'totals' })
    rollupAnswer = () => new Response('error', { status: 503 })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const summary = await runAnalyticsExport(env, options)

    expect(summary).toMatchObject({ stopped: 'analytics_unavailable' })
    expect(await rollupStep(OLDEST, 'totals')).toMatchObject({ attempts: 0, completedAt: null, startedAt: null })
  })

  it('counts an attempt for a row it cannot read, and parks the step after 3', async () => {
    await leave({ day: OLDEST, step: 'totals' })
    const bad = ['"lots"', 'true', '"0x1f"']
    let run = 0
    rollupAnswer = () => new Response(`{"link_id":"id-a","slug":"a","visits":${bad[run++]},"visitors":1,"referers":0}\n`)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    for (let attempt = 0; attempt < 3; attempt++)
      await runAnalyticsExport(env, options)

    expect(await rollupStep(OLDEST, 'totals')).toMatchObject({ attempts: 3, completedAt: null, parkedAt: expect.any(Number) })
    expect(errors.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({ event: 'analytics_export.step_parked', step: 'totals', reason: 'bad_row' }))
    expect(await db.select().from(analyticsDaily)).toHaveLength(0)
  })

  it('skips rollup steps once 50,000 rows were written today, still archives, and starts again the next day', async () => {
    await leave({ day: OLDEST, step: 'totals' }, { day: NEWEST, step: 'archive:23' })
    await db.insert(analyticsExportBudget).values({ utcDay: '2026-11-14', rowsWritten: 50_000 })
    rollupAnswer = () => lines([{ link_id: 'id-a', slug: 'a', visits: 1, visitors: 1, referers: 0 }])
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runAnalyticsExport(env, options)

    expect((await stepRow(NEWEST, 23))?.completedAt).toEqual(expect.any(Number))
    expect((await rollupStep(OLDEST, 'totals'))?.completedAt).toBeNull()
    expect(warns).not.toHaveBeenCalled()

    await runAnalyticsExport(env, { ...options, now: NOW + 3_600_000 * 24 })
    // OLDEST is now 91 days old and out of the window; the next day's totals run.
    await leave({ day: '2026-08-17', step: 'totals' })
    await runAnalyticsExport(env, { ...options, now: NOW + 3_600_000 * 24 })
    expect((await rollupStep('2026-08-17', 'totals'))?.completedAt).toEqual(expect.any(Number))
  })

  it('logs the write budget once, when a step crosses it during the day', async () => {
    const noon = NOW + 12 * 3_600_000
    await leave({ day: OLDEST, step: 'totals' }, { day: '2026-08-17', step: 'totals' })
    await db.insert(analyticsExportBudget).values({ utcDay: '2026-11-14', rowsWritten: 49_999 })
    rollupAnswer = () => lines([{ link_id: 'id-a', slug: 'a', visits: 1, visitors: 1, referers: 0 }, { link_id: 'id-b', slug: 'b', visits: 1, visitors: 1, referers: 0 }])
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runAnalyticsExport(env, { ...options, now: noon })
    await runAnalyticsExport(env, { ...options, now: noon + 300_000 })

    expect((await rollupStep(OLDEST, 'totals'))?.completedAt).toEqual(expect.any(Number))
    // The crossing step finishes; nothing after it runs today.
    expect((await rollupStep('2026-08-17', 'totals'))?.completedAt).toBeNull()
    const budgetLogs = warns.mock.calls.map(([entry]) => entry).filter(entry => (entry as { event?: string }).event === 'analytics_export.write_budget')
    expect(budgetLogs).toEqual([expect.objectContaining({ rowsWritten: 50_001 })])
  })

  it('skips rollup steps while the database is over its size limit, and still archives', async () => {
    await leave({ day: OLDEST, step: 'totals' }, { day: NEWEST, step: 'archive:23' })
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runAnalyticsExport(env, { ...options, maxDatabaseBytes: 1 })

    expect((await stepRow(NEWEST, 23))?.completedAt).toEqual(expect.any(Number))
    expect((await rollupStep(OLDEST, 'totals'))?.completedAt).toBeNull()
    expect(warns.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({ event: 'analytics_export.size_limit' }))
  })

  it('counts an attempt for a page too large for one D1 value, and goes on to the next step', async () => {
    await leave({ day: OLDEST, step: 'breakdown:referer' }, { day: '2026-08-17', step: 'totals' })
    // Records written before the referer cap can hold hosts of many kilobytes.
    const long = 'h'.repeat(4_000)
    rollupAnswer = sql => sql.includes('blob5 as value')
      ? lines(Array.from({ length: 300 }, (_, i) => ({ link_id: 'id-a', value: `${long}${i}`, visits: 1, visitors: 1 })))
      : lines([{ link_id: 'id-a', slug: 'a', visits: 1, visitors: 1, referers: 0 }])
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runAnalyticsExport(env, options)

    expect(await rollupStep(OLDEST, 'breakdown:referer')).toMatchObject({ attempts: 1, completedAt: null })
    expect(await db.select().from(analyticsDailyBreakdown)).toHaveLength(0)
    expect((await rollupStep('2026-08-17', 'totals'))?.completedAt).toEqual(expect.any(Number))
    expect(warns.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({ event: 'analytics_export.step_failed', reason: 'page_too_large' }))
  })

  it('treats an unknown database size as over the limit', async () => {
    await leave({ day: OLDEST, step: 'totals' }, { day: NEWEST, step: 'archive:23' })
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A D1 that leaves `size_after` out of the budget read's result.
    const DB = new Proxy(env.DB, {
      get(target, key) {
        if (key === 'prepare') {
          return (query: string) => {
            const statement = target.prepare(query)
            if (!query.startsWith('SELECT rows_written'))
              return statement
            return {
              bind: (...values: unknown[]) => ({
                all: async () => {
                  const result = await statement.bind(...values).all()
                  return { ...result, meta: { ...result.meta, size_after: undefined } }
                },
              }),
            }
          }
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    await runAnalyticsExport({ ...env, DB } as Cloudflare.Env, options)

    expect((await stepRow(NEWEST, 23))?.completedAt).toEqual(expect.any(Number))
    expect((await rollupStep(OLDEST, 'totals'))?.completedAt).toBeNull()
    expect(warns.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({ event: 'analytics_export.size_limit', databaseBytes: null }))
  })

  // A rollup query carries a visitor-controlled resume key, so a rejected
  // query may be specific to one step: it must not hold up every other step.
  for (const status of [400, 422]) {
    it(`counts an attempt when Analytics Engine rejects a query with a resume key with ${status}, and goes on to the next step`, async () => {
      await leave({ day: OLDEST, step: 'breakdown:referer' }, { day: '2026-08-17', step: 'totals' })
      await db.update(analyticsExportSteps).set({ nextKey: JSON.stringify(['id-a', 'crafted.example']) }).where(and(eq(analyticsExportSteps.day, OLDEST), eq(analyticsExportSteps.step, 'breakdown:referer')))
      rollupAnswer = sql => sql.includes('blob5 as value')
        ? new Response('rejected', { status })
        : lines([{ link_id: 'id-a', slug: 'a', visits: 1, visitors: 1, referers: 0 }])
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

      await runAnalyticsExport(env, options)

      expect(await rollupStep(OLDEST, 'breakdown:referer')).toMatchObject({ attempts: 1, completedAt: null, startedAt: null })
      expect((await rollupStep('2026-08-17', 'totals'))?.completedAt).toEqual(expect.any(Number))

      await runAnalyticsExport(env, options)
      await runAnalyticsExport(env, options)
      expect(await rollupStep(OLDEST, 'breakdown:referer')).toMatchObject({ attempts: 3, parkedAt: expect.any(Number) })
      expect(errors.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({ event: 'analytics_export.step_parked', step: 'breakdown:referer', reason: `status_${status}` }))
    })

    it(`stops the run without counting an attempt when a query with no resume key is rejected with ${status}`, async () => {
      await leave({ day: OLDEST, step: 'totals' })
      rollupAnswer = () => new Response('rejected', { status })
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      const summary = await runAnalyticsExport(env, options)

      expect(summary).toMatchObject({ stopped: 'analytics_unavailable' })
      expect(await rollupStep(OLDEST, 'totals')).toMatchObject({ attempts: 0, completedAt: null })
    })
  }
})

describe('analytics export trigger', { concurrent: false }, () => {
  it('is listed in wrangler.jsonc', () => {
    expect(wranglerConfig).toContain(`"${ANALYTICS_EXPORT_CRON}"`)
  })

  it('runs the export on the 5-minute trigger, reading the credentials from the bindings', { timeout: 30_000 }, async () => {
    const bindings = env as Cloudflare.Env & Record<string, unknown>
    const saved = { account: bindings.NUXT_CF_ACCOUNT_ID, token: bindings.NUXT_CF_API_TOKEN }
    bindings.NUXT_CF_ACCOUNT_ID = ACCOUNT
    bindings.NUXT_CF_API_TOKEN = TOKEN
    try {
      await runScheduledTasks(ANALYTICS_EXPORT_CRON)
      await vi.waitFor(() => expect(analyticsCalls().length).toBeGreaterThan(0), { timeout: 20_000, interval: 200 })
    }
    finally {
      bindings.NUXT_CF_ACCOUNT_ID = saved.account
      bindings.NUXT_CF_API_TOKEN = saved.token
    }
  })
})
