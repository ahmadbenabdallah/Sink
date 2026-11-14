/**
 * The cron trigger of the analytics export job, which runs every 5 minutes.
 * It must match the expression in `wrangler.jsonc`.
 */
export const ANALYTICS_EXPORT_CRON = '*/5 * * * *'

/**
 * Whether a scheduled event was fired by the analytics export trigger.
 *
 * The jobs that run once a day (link backup, expired-link cleanup, password
 * re-hashing) return early on this trigger, or they would run 288 times a day.
 * They check for this trigger rather than for the daily one, so an owner who
 * changed the daily schedule in wrangler.jsonc keeps those jobs running.
 */
export function isAnalyticsExportRun(event: { controller?: { cron?: string } }): boolean {
  return event.controller?.cron === ANALYTICS_EXPORT_CRON
}
