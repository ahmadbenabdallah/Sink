import { describe, expect, it } from 'vitest'
import { summarizeHistory } from '../../app/utils/analysis-history'

describe('summarizeHistory', () => {
  it('says nothing when no part of the page reached past three months', () => {
    expect(summarizeHistory([undefined, undefined])).toEqual({ fromRollups: false, missingDays: 0, recentOnly: false, budgetReached: false })
  })

  it('notes daily totals and the most missing days any daily part reported', () => {
    expect(summarizeHistory([
      { daysFromRollups: 30, missingDays: 2 },
      { daysFromRollups: 29, missingDays: 3 },
    ])).toEqual({ fromRollups: true, missingDays: 3, recentOnly: false, budgetReached: false })
  })

  it('notes a part that only covers recent days, without counting its old days as missing', () => {
    expect(summarizeHistory([
      { daysFromRollups: 0, missingDays: 40, unavailable: 'unit' },
      { daysFromRollups: 40, missingDays: 0 },
    ])).toEqual({ fromRollups: true, missingDays: 0, recentOnly: true, budgetReached: false })
  })

  it('notes that the daily read limit was reached', () => {
    expect(summarizeHistory([{ daysFromRollups: 0, missingDays: 0, unavailable: 'budget' }]))
      .toEqual({ fromRollups: false, missingDays: 0, recentOnly: false, budgetReached: true })
  })
})
