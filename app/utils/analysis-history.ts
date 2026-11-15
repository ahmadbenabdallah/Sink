import type { AnalyticsHistory } from '#shared/types/analytics-history'

/** What the Analysis page's history note says, from the `history` of each part of the page. */
export function summarizeHistory(parts: (AnalyticsHistory | undefined)[]) {
  const reported = parts.filter((part): part is AnalyticsHistory => part !== undefined)
  // A part that did not read its old days reports every one as missing; that is not a gap.
  const daily = reported.filter(part => part.unavailable === undefined)
  return {
    fromRollups: daily.some(part => part.daysFromRollups > 0),
    missingDays: Math.max(0, ...daily.map(part => part.missingDays)),
    recentOnly: reported.some(part => part.unavailable === 'unit'),
    budgetReached: reported.some(part => part.unavailable === 'budget'),
  }
}
