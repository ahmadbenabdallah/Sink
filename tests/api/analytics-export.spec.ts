import { env } from 'cloudflare:workers'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyticsExportSteps } from '../../server/database/schema'
import { archiveKey, hourWindow, runAnalyticsExport } from '../../server/utils/analytics-export'
import { ANALYTICS_EXPORT_CRON } from '../../server/utils/cron'
import wranglerConfig from '../../wrangler.jsonc?raw'
import { db, runScheduledTasks } from '../utils'

vi.mock('#shared/utils/flag', () => ({ getFlag: vi.fn() }))

const NOW = Date.UTC(2026, 10, 14, 0, 2) // 2026-11-14 00:02 UTC
const OLDEST = '2026-08-21' // 85 days before NOW
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

function ndjson(count: number, hourStart: number) {
  return Array.from({ length: count }, (_, i) => JSON.stringify({ timestamp: new Date((hourStart + i) * 1000).toISOString(), _sample_interval: 1, index1: `id-${i}`, slug: `s${i}` }))
}

function analyticsCalls() {
  return fetchSpy.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).includes('/analytics_engine/sql'))
}

function stubAnalyticsEngine() {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`))
      throw new Error(`Unexpected outbound request to ${url}`)
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`)
    const sql = String(init?.body)
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

beforeEach(async () => {
  hours = new Map()
  stubAnalyticsEngine()
  await db.delete(analyticsExportSteps)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await db.delete(analyticsExportSteps)
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

  it('seeds every hour of every day from 85 to 2 days old, and nothing else', async () => {
    await runAnalyticsExport(env, options)

    const rows = await db.select({ day: analyticsExportSteps.day }).from(analyticsExportSteps)
    const days = [...new Set(rows.map(row => row.day))].sort()
    expect(days[0]).toBe(OLDEST)
    expect(days.at(-1)).toBe(NEWEST)
    expect(rows).toHaveLength(84 * 24)
  })

  it('adds only the 24 hours of the newly eligible day on the next UTC day', async () => {
    await runAnalyticsExport(env, options)
    await runAnalyticsExport(env, { ...options, now: NOW + DAY_MS })

    const rows = await db.select({ day: analyticsExportSteps.day }).from(analyticsExportSteps)
    expect(rows).toHaveLength(85 * 24)
    expect(rows.filter(row => row.day === '2026-11-13')).toHaveLength(24)
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
