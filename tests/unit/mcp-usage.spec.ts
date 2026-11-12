import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpUsage } from '../../server/database/schema'
import { DEFAULT_DAILY_CALL_LIMIT, reserveToolCall, resolveDailyCallLimit, usageDay, usageSummary } from '../../server/services/mcp/usage'
import { db } from '../utils'

const DAY_SECONDS = 86400

function callerId() {
  return `usage-${crypto.randomUUID()}`
}

/** The UTC day `days` before today, in the form the table stores. */
function dayAgo(days: number) {
  return usageDay(new Date(Date.now() - days * DAY_SECONDS * 1000))
}

async function countedToday(caller: string) {
  const [row] = await db.select().from(mcpUsage).where(and(eq(mcpUsage.callerId, caller), eq(mcpUsage.day, usageDay())))
  return row?.calls ?? 0
}

const failingDatabase = new Proxy({}, {
  get() {
    throw new Error('D1 is unavailable')
  },
}) as DrizzleD1Database

afterEach(() => {
  vi.restoreAllMocks()
})

describe('usageDay', () => {
  it('is the UTC date', () => {
    expect(usageDay(new Date('2026-03-04T23:59:59Z'))).toBe('2026-03-04')
    expect(usageDay(new Date('2026-03-05T00:00:00Z'))).toBe('2026-03-05')
  })
})

describe('reserveToolCall', () => {
  it('counts each call it allows, for its caller and day', async () => {
    const caller = callerId()
    const before = Math.floor(Date.now() / 1000)

    expect(await reserveToolCall(db, caller, 10)).toBe(true)
    expect(await reserveToolCall(db, caller, 10)).toBe(true)
    expect(await reserveToolCall(db, caller, 10)).toBe(true)

    expect(await countedToday(caller)).toBe(3)
    expect(await countedToday(callerId())).toBe(0)

    const [row] = await db.select().from(mcpUsage).where(eq(mcpUsage.callerId, caller))
    expect(row!.lastUsedAt).toBeGreaterThanOrEqual(before)
  })

  it('refuses a call at the limit and does not count it', async () => {
    const caller = callerId()

    expect(await reserveToolCall(db, caller, 2)).toBe(true)
    expect(await reserveToolCall(db, caller, 2)).toBe(true)
    expect(await reserveToolCall(db, caller, 2)).toBe(false)
    expect(await reserveToolCall(db, caller, 2)).toBe(false)

    expect(await countedToday(caller)).toBe(2)
  })

  // Checking and counting are one statement, so calls that arrive together
  // cannot all read "one below the limit" and all go through.
  it('lets exactly the limit through when calls arrive together', async () => {
    const caller = callerId()

    const allowed = await Promise.all(Array.from({ length: 20 }, () => reserveToolCall(db, caller, 5)))

    expect(allowed.filter(Boolean)).toHaveLength(5)
    expect(await countedToday(caller)).toBe(5)
  })

  it('starts again on a new day', async () => {
    const caller = callerId()
    await db.insert(mcpUsage).values({ callerId: caller, day: dayAgo(1), calls: 2, lastUsedAt: 1 })

    expect(await reserveToolCall(db, caller, 2)).toBe(true)
    expect(await countedToday(caller)).toBe(1)
  })

  // The caller of this function decides what a database failure means for the
  // tool call. It must not be read as "allowed" or "refused" here.
  it('throws when the database fails', async () => {
    await expect(reserveToolCall(failingDatabase, 'someone', 10)).rejects.toThrow()
  })
})

describe('usageSummary', () => {
  it('adds up today and the six days before it, and nothing older', async () => {
    const caller = callerId()
    const now = Math.floor(Date.now() / 1000)
    await db.insert(mcpUsage).values([
      { callerId: caller, day: dayAgo(0), calls: 1, lastUsedAt: now },
      { callerId: caller, day: dayAgo(6), calls: 10, lastUsedAt: now - 6 * DAY_SECONDS },
      { callerId: caller, day: dayAgo(7), calls: 100, lastUsedAt: now - 7 * DAY_SECONDS },
    ])

    expect((await usageSummary(db)).get(caller)).toEqual({ calls7d: 11, lastUsedAt: now })
  })

  // An idle connector is exactly the one an owner wants to spot, so the last
  // use is taken from every day on record, not only from the window.
  it('reports the last use of a caller that has been idle for longer than the window', async () => {
    const caller = callerId()
    const longAgo = Math.floor(Date.now() / 1000) - 30 * DAY_SECONDS
    await db.insert(mcpUsage).values({ callerId: caller, day: dayAgo(30), calls: 5, lastUsedAt: longAgo })

    expect((await usageSummary(db)).get(caller)).toEqual({ calls7d: 0, lastUsedAt: longAgo })
  })

  it('has no entry for a caller that never made a call', async () => {
    expect((await usageSummary(db)).has(callerId())).toBe(false)
  })

  it('throws when usage cannot be read, so it is not mistaken for zero', async () => {
    await expect(usageSummary(failingDatabase)).rejects.toThrow()
  })
})

describe('resolveDailyCallLimit', () => {
  it.each([
    [5000, 5000],
    ['250', 250],
    [' 250 ', 250],
    [1, 1],
  ])('uses %j as the limit', (configured, limit) => {
    expect(resolveDailyCallLimit(configured)).toBe(limit)
  })

  // Only a plain whole number above zero is a limit. Anything else falls back
  // to the default, so a typo can never switch the limit off.
  it.each([undefined, '', 0, -5, 2.5, 'many', '0x10', '+5', '1e3', '5 000', Number.NaN, Number.POSITIVE_INFINITY, true, null])('falls back to the default for %j', (configured) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveDailyCallLimit(configured)).toBe(DEFAULT_DAILY_CALL_LIMIT)
  })

  it('does not warn about an unset value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    resolveDailyCallLimit(undefined)
    resolveDailyCallLimit('')

    expect(warn).not.toHaveBeenCalled()
  })

  // The limit is resolved on every request, so the warning must not repeat.
  it('warns once about a value it cannot use', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const value = `not-a-number-${crypto.randomUUID()}`

    resolveDailyCallLimit(value)
    resolveDailyCallLimit(value)

    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: 'mcp_usage.invalid_daily_limit' }))
  })
})
