import { describe, expect, it } from 'vitest'
import { isAnalyticsExportRun } from '../../server/utils/cron'

describe('isAnalyticsExportRun', () => {
  it('matches only the 5-minute export trigger', () => {
    expect(isAnalyticsExportRun({ controller: { cron: '*/5 * * * *' } })).toBe(true)
  })

  // Anything else lets the daily jobs run: they must never stop by accident.
  it('does not match the daily trigger, another schedule, or a missing cron', () => {
    for (const cron of ['0 0 * * *', '0 3 * * *', '*/5  * * * *', '0/5 * * * *', ''])
      expect(isAnalyticsExportRun({ controller: { cron } }), cron).toBe(false)
    expect(isAnalyticsExportRun({ controller: {} })).toBe(false)
    expect(isAnalyticsExportRun({})).toBe(false)
  })
})
