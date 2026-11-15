import type { H3Event } from 'h3'
import { describe, expect, it, vi } from 'vitest'
import { countersWithHistory, historyPlan, mergeCounters, mergeMetrics, mergeViews, needsUnavailableFilter } from '../../server/utils/analytics-history'

vi.mock('#shared/utils/flag', () => ({ getFlag: vi.fn() }))

const NOW = Date.UTC(2027, 2, 1, 10) // 2027-03-01 10:00 UTC
const BOUNDARY = Date.UTC(2026, 11, 3) / 1000 // 88 days before 2027-03-01
const at = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m, d, h) / 1000

describe('historyPlan', () => {
  it('is null without a start, so the link cards and MCP tools read Analytics Engine as today', () => {
    expect(historyPlan({}, NOW)).toBeNull()
    expect(historyPlan({ endAt: at(2026, 10, 1) }, NOW)).toBeNull()
  })

  it('is null when the whole range is within the last 88 days', () => {
    expect(historyPlan({ startAt: BOUNDARY, endAt: NOW / 1000 }, NOW)).toBeNull()
    expect(historyPlan({ startAt: at(2027, 1, 1), endAt: NOW / 1000 }, NOW)).toBeNull()
  })

  it('splits a range at the start of the UTC day 88 days ago: whole older UTC days, then the rest', () => {
    expect(historyPlan({ startAt: at(2026, 11, 1, 23), endAt: NOW / 1000 }, NOW)).toEqual({
      oldDays: ['2026-12-01', '2026-12-02'],
      recent: { startAt: BOUNDARY, endAt: NOW / 1000 },
      skippedDays: 0,
    })
  })

  it('reads no recent part when the whole range is older, and stops at the end of the range', () => {
    expect(historyPlan({ startAt: at(2026, 10, 28), endAt: at(2026, 10, 30, 12) }, NOW)).toEqual({
      oldDays: ['2026-11-28', '2026-11-29', '2026-11-30'],
      recent: null,
      skippedDays: 0,
    })
  })

  it('reaches to now when the range has no end', () => {
    expect(historyPlan({ startAt: at(2026, 11, 2) }, NOW)).toEqual({
      oldDays: ['2026-12-02'],
      recent: { startAt: BOUNDARY, endAt: NOW / 1000 },
      skippedDays: 0,
    })
  })

  it('reads at most the 366 days before the boundary, and counts the earlier ones as skipped', () => {
    const plan = historyPlan({ startAt: BOUNDARY - 400 * 86_400, endAt: NOW / 1000 }, NOW)!
    expect(plan.oldDays).toHaveLength(366)
    expect(plan.oldDays[0]).toBe(new Date((BOUNDARY - 366 * 86_400) * 1000).toISOString().slice(0, 10))
    expect(plan.oldDays.at(-1)).toBe('2026-12-02')
    expect(plan.skippedDays).toBe(34)
  })

  it('stays bounded for any start, however far back', () => {
    const plan = historyPlan({ startAt: -8_000_000_000_000, endAt: NOW / 1000 }, NOW)!
    expect(plan.oldDays).toHaveLength(366)
    expect(plan.skippedDays).toBeGreaterThan(0)
  })
})

describe('needsUnavailableFilter', () => {
  it('allows the link and slug filters, which the daily rows hold', () => {
    expect(needsUnavailableFilter({ id: 'a', slug: 'b', startAt: 1, endAt: 2 })).toBe(false)
  })

  it('refuses any other filter, which the daily rows cannot apply', () => {
    expect(needsUnavailableFilter({ country: 'FR' })).toBe(true)
    expect(needsUnavailableFilter({ referer: 'news.example' })).toBe(true)
    expect(needsUnavailableFilter({ url: 'https://example.com' })).toBe(true)
    expect(needsUnavailableFilter({ country: '' })).toBe(false)
  })
})

describe('mergeCounters', () => {
  it('adds the old totals to the recent ones; Analytics Engine sends strings', () => {
    expect(mergeCounters([{ visits: '10', visitors: '4', referers: 1 }], [{ visits: 5, visitors: 2, referers: 2 }], false))
      .toEqual([{ visits: 15, visitors: 6, referers: 3 }])
  })

  it('keeps one row when only one part has data', () => {
    expect(mergeCounters([], [{ visits: 5, visitors: 2, referers: 0 }], false)).toEqual([{ visits: 5, visitors: 2, referers: 0 }])
    expect(mergeCounters([{ visits: 1, visitors: 1, referers: 0 }], [], false)).toEqual([{ visits: 1, visitors: 1, referers: 0 }])
    expect(mergeCounters([], [], false)).toEqual([])
  })

  it('adds per link when the request is by link id', () => {
    expect(mergeCounters(
      [{ id: 'a', visits: 1, visitors: 1, referers: 0 }, { id: 'b', visits: 2, visitors: 2, referers: 1 }],
      [{ id: 'a', visits: 10, visitors: 3, referers: 1 }, { id: 'c', visits: 4, visitors: 4, referers: 0 }],
      true,
    )).toEqual([
      { id: 'a', visits: 11, visitors: 4, referers: 1 },
      { id: 'b', visits: 2, visitors: 2, referers: 1 },
      { id: 'c', visits: 4, visitors: 4, referers: 0 },
    ])
  })
})

describe('mergeViews', () => {
  it('puts the old days first, then the recent points', () => {
    expect(mergeViews([{ time: '2026-12-01', visits: 3, visitors: 2 }], [{ time: '2026-12-03', visits: '1', visitors: '1' }]))
      .toEqual([{ time: '2026-12-01', visits: 3, visitors: 2 }, { time: '2026-12-03', visits: 1, visitors: 1 }])
  })
})

describe('mergeViews at the boundary', () => {
  it('adds points that share a date label, as for a viewer west of UTC', () => {
    expect(mergeViews(
      [{ time: '2026-12-02', visits: 3, visitors: 2 }],
      [{ time: '2026-12-02', visits: '1', visitors: '1' }, { time: '2026-12-03', visits: 4, visitors: 2 }],
    )).toEqual([
      { time: '2026-12-02', visits: 4, visitors: 3 },
      { time: '2026-12-03', visits: 4, visitors: 2 },
    ])
  })
})

describe('countersWithHistory under a filter the daily rows cannot apply', () => {
  it('reads the whole range from Analytics Engine, which still holds days 88 to about 92', async () => {
    const event = { context: { cloudflare: { env: {} } } } as unknown as H3Event
    const query = { startAt: at(2026, 11, 1), endAt: NOW / 1000, country: 'FR' }
    const readRecent = vi.fn(async () => ({ data: [{ visits: 1, visitors: 1, referers: 0 }] }))

    const answer = await countersWithHistory(event, historyPlan(query, NOW)!, query, readRecent)

    expect(readRecent).toHaveBeenCalledWith({ startAt: query.startAt, endAt: query.endAt })
    expect(answer).toEqual({ data: [{ visits: 1, visitors: 1, referers: 0 }], history: { daysFromRollups: 0, missingDays: 2, unavailable: 'filter' } })
  })
})

describe('mergeMetrics', () => {
  it('adds counts per name, sorts again and keeps the limit', () => {
    expect(mergeMetrics(
      [{ name: 'FR', count: 3 }, { name: 'DE', count: 1 }],
      [{ name: 'DE', count: '5' }, { name: 'US', count: 2 }, { name: 'IT', count: 1 }],
      3,
    )).toEqual([{ name: 'DE', count: 6 }, { name: 'FR', count: 3 }, { name: 'US', count: 2 }])
  })
})
