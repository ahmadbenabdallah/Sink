import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { analyticsDaily, analyticsDailyBreakdown, analyticsExportBudget, analyticsExportSteps, deletedLinkIds } from '../../server/database/schema'
import { daySteps } from '../../server/utils/analytics-export'
import { db, fetchWithAuth } from '../utils'

vi.mock('#shared/utils/flag', () => ({ getFlag: vi.fn() }))

// Days older than 88 days are read from the daily rollups in D1. The tests
// have no Cloudflare credentials, so the recent part answers no rows and
// every number below comes from D1.

const DAY = 86_400
const today = Math.floor(Date.now() / 1000 / DAY) * DAY
const dayName = (age: number) => new Date((today - age * DAY) * 1000).toISOString().slice(0, 10)
const FINISHED = [dayName(95), dayName(94)]
const UNFINISHED = dayName(93)
const OLD = { startAt: today - 95 * DAY, endAt: today - 92 * DAY - 1 }
const run = crypto.randomUUID().slice(0, 6)
const A = `hist-a-${run}`
const B = `hist-b-${run}`
const DELETED = `hist-d-${run}`

async function get(path: string, query: Record<string, string | number>) {
  const response = await fetchWithAuth(`${path}?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`)
  expect(response.status).toBe(200)
  return await response.json() as { data: Record<string, unknown>[], history?: Record<string, unknown> }
}

beforeAll(async () => {
  const rollupSteps = daySteps().filter(step => !step.startsWith('archive:'))
  // One day per insert keeps each statement under D1's 100 bound parameters.
  for (const day of FINISHED)
    await db.insert(analyticsExportSteps).values(rollupSteps.map(step => ({ day, step, completedAt: 1 })))
  // One rollup step is still pending, so the day is not finished.
  await db.insert(analyticsExportSteps).values(rollupSteps.map((step, index) => ({ day: UNFINISHED, step, completedAt: index === 0 ? null : 1 })))
  await db.insert(analyticsDaily).values([
    { day: FINISHED[0]!, linkId: A, slug: 'a', visits: 10, visitors: 4, referers: 1 },
    { day: FINISHED[0]!, linkId: B, slug: 'b', visits: 3, visitors: 3, referers: 0 },
    { day: FINISHED[0]!, linkId: DELETED, slug: 'd', visits: 100, visitors: 50, referers: 9 },
    { day: FINISHED[1]!, linkId: A, slug: 'a', visits: 5, visitors: 2, referers: 1 },
    { day: UNFINISHED, linkId: A, slug: 'a', visits: 7, visitors: 7, referers: 7 },
  ])
  await db.insert(analyticsDailyBreakdown).values([
    { dimension: 'country', day: FINISHED[0]!, linkId: A, value: 'FR', visits: 6, visitors: 3 },
    { dimension: 'country', day: FINISHED[0]!, linkId: A, value: 'DE', visits: 2, visitors: 1 },
    { dimension: 'country', day: FINISHED[0]!, linkId: B, value: 'FR', visits: 3, visitors: 3 },
    { dimension: 'country', day: FINISHED[0]!, linkId: DELETED, value: 'FR', visits: 100, visitors: 50 },
    { dimension: 'country', day: FINISHED[1]!, linkId: A, value: 'DE', visits: 5, visitors: 2 },
    { dimension: 'country', day: UNFINISHED, linkId: A, value: 'IT', visits: 7, visitors: 7 },
  ])
  await db.insert(deletedLinkIds).values({ id: DELETED, deletedAt: today })
})

afterAll(async () => {
  const days = [...FINISHED, UNFINISHED]
  await db.delete(analyticsExportSteps).where(inArray(analyticsExportSteps.day, days))
  await db.delete(analyticsDaily).where(inArray(analyticsDaily.day, days))
  await db.delete(analyticsDailyBreakdown).where(inArray(analyticsDailyBreakdown.day, days))
  await db.delete(deletedLinkIds).where(inArray(deletedLinkIds.id, [DELETED]))
})

describe('analytics older than 88 days', { concurrent: false }, () => {
  it('adds the finished days\' totals, counts an unfinished day as missing, and leaves out deleted links', async () => {
    expect(await get('/api/stats/counters', OLD)).toMatchObject({
      data: [{ visits: 18, visitors: 9, referers: 2 }],
      history: { daysFromRollups: 2, missingDays: 1 },
    })
  })

  it('applies the link and slug filters to the old days', async () => {
    expect((await get('/api/stats/counters', { ...OLD, id: A })).data).toEqual([{ id: A, visits: 15, visitors: 6, referers: 2 }])
    expect((await get('/api/stats/counters', { ...OLD, slug: 'b' })).data).toEqual([{ visits: 3, visitors: 3, referers: 0 }])
  })

  it('does not read the old days under a filter the daily rows cannot apply, and says so', async () => {
    expect(await get('/api/stats/counters', { ...OLD, country: 'FR' })).toEqual({
      data: [],
      history: { daysFromRollups: 0, missingDays: 3, unavailable: 'filter' },
    })
  })

  it('charts the finished days by UTC date', async () => {
    expect(await get('/api/stats/views', { ...OLD, unit: 'day', clientTimezone: 'Europe/Paris' })).toMatchObject({
      data: [
        { time: FINISHED[0], visits: 13, visitors: 7 },
        { time: FINISHED[1], visits: 5, visitors: 2 },
      ],
      history: { daysFromRollups: 2, missingDays: 1 },
    })
  })

  it('answers per-minute and per-hour views and the heatmap from recent days only, and says so', async () => {
    const oneOldDay = { startAt: today - 95 * DAY, endAt: today - 94 * DAY - 1 }
    expect((await get('/api/stats/views', { ...oneOldDay, unit: 'hour', clientTimezone: 'Etc/UTC' })).history)
      .toEqual({ daysFromRollups: 0, missingDays: 1, unavailable: 'unit' })
    expect((await get('/api/stats/heatmap', { ...OLD, clientTimezone: 'Etc/UTC' })).history)
      .toEqual({ daysFromRollups: 0, missingDays: 3, unavailable: 'unit' })
  })

  it('adds breakdown counts per value, with the slug filter matched through the daily totals', async () => {
    expect((await get('/api/stats/metrics', { ...OLD, type: 'country' })).data).toEqual([{ name: 'FR', count: 9 }, { name: 'DE', count: 7 }])
    expect((await get('/api/stats/metrics', { ...OLD, type: 'country', slug: 'b' })).data).toEqual([{ name: 'FR', count: 3 }])
    expect((await get('/api/stats/metrics', { ...OLD, type: 'slug' })).data).toEqual([{ name: 'a', count: 15 }, { name: 'b', count: 3 }])
  })

  it('reads the whole range from Analytics Engine, as before, when no rollup has ever finished', async () => {
    const days = [...FINISHED, UNFINISHED]
    await db.update(analyticsExportSteps).set({ completedAt: null }).where(inArray(analyticsExportSteps.day, days))
    try {
      expect(await get('/api/stats/counters', OLD)).toEqual({ data: [] })
    }
    finally {
      const rollupSteps = daySteps().filter(step => !step.startsWith('archive:'))
      for (const day of FINISHED)
        await db.update(analyticsExportSteps).set({ completedAt: 1 }).where(and(eq(analyticsExportSteps.day, day), inArray(analyticsExportSteps.step, rollupSteps)))
      await db.update(analyticsExportSteps).set({ completedAt: 1 }).where(and(eq(analyticsExportSteps.day, UNFINISHED), inArray(analyticsExportSteps.step, rollupSteps.slice(1))))
    }
  })

  it(`counts the D1 rows it reads against today's read budget`, async () => {
    const utcDay = new Date(today * 1000).toISOString().slice(0, 10)
    await db.delete(analyticsExportBudget).where(eq(analyticsExportBudget.utcDay, utcDay))

    await get('/api/stats/counters', OLD)

    const [budget] = await db.select().from(analyticsExportBudget).where(eq(analyticsExportBudget.utcDay, utcDay))
    expect(budget?.rowsRead).toBeGreaterThan(0)
  })

  it(`does not read the old days once today's read budget is used up, and says so`, async () => {
    const utcDay = new Date(today * 1000).toISOString().slice(0, 10)
    await db.insert(analyticsExportBudget).values({ utcDay, rowsRead: 2_000_000 }).onConflictDoUpdate({ target: analyticsExportBudget.utcDay, set: { rowsRead: 2_000_000 } })
    try {
      expect(await get('/api/stats/counters', OLD)).toEqual({
        data: [],
        history: { daysFromRollups: 0, missingDays: 3, unavailable: 'budget' },
      })
    }
    finally {
      await db.delete(analyticsExportBudget).where(eq(analyticsExportBudget.utcDay, utcDay))
    }
  })

  it('leaves a range within the last 88 days unchanged', async () => {
    const recent = await get('/api/stats/counters', { startAt: today - 7 * DAY, endAt: today })
    expect(recent).toEqual({ data: [] })
  })
})
