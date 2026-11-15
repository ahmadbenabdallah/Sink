/**
 * How a stats answer read the days older than three months, which come from
 * the daily rollups in D1 (server/utils/analytics-history.ts). Present only
 * when the range reaches that far back.
 */
export interface AnalyticsHistory {
  /** Old days read from D1. */
  daysFromRollups: number
  /** Old days without data: not rolled up (yet or ever), or past the 366 days one request reads. Never counted as zero. */
  missingDays: number
  /**
   * Old days not read: a filter the daily rows cannot apply, a time unit finer
   * than a day, or today's D1 read budget is used up.
   */
  unavailable?: 'filter' | 'unit' | 'budget'
}
