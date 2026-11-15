---
title: Analytics and Realtime
description: Turn on visit analytics, read charts and logs, understand near-realtime view, exclude bots, and export CSV.
---

# Analytics and Realtime

Analytics is **optional**. Without it, short links, login, and link management still work — charts, logs, and realtime stay empty.

## Turn it on (three things)

You need all three:

1. **Analytics Engine binding** named `ANALYTICS`
   - **Workers:** usually created by deploy settings (dataset default `sink`)
   - **Pages:** **Settings → Bindings → Add → Analytics Engine**
   - Variable name: `ANALYTICS`
   - Dataset: `sink` by default. If you set `NUXT_DATASET`, use the same name here

2. **Account ID** — set `NUXT_CF_ACCOUNT_ID` to the Cloudflare account that hosts this app  
   (Dashboard sidebar → account name, or the URL after you log in)

3. **API token** — set `NUXT_CF_API_TOKEN` as an encrypted secret:
   - Cloudflare dashboard → profile icon → **My Profile** → **API Tokens** → **Create Token** → **Custom Token**
   - Permission: **Account → Account Analytics → Read** only
   - Prefer limiting the token to that same account

If any one is missing or mismatched, analytics stays empty.

## What you can see

Successful visits feed counters, charts, heatmaps, recent events, and locations. Filter by link, time, country, browser, OS, device, and referrer.

Numbers can be **approximate** (Cloudflare samples high traffic). Low traffic can look uneven for the same reason.

To hide detected bots from stats and [click webhooks](/configuration/webhooks), set `NUXT_DISABLE_BOT_ACCESS_LOG=true`.

**Deleted links are hidden.** When you delete a link (from the dashboard, the API or the MCP `delete_link` tool), its traffic disappears from every chart, list, export and MCP analytics answer. A new link that reuses the slug starts from zero. Restoring the link by import, which keeps its id, brings its history back. Links removed automatically by the [expired-link cleanup](/configuration/) keep their history, and links deleted before this version stay visible until Analytics Engine expires their data. Only the 2,000 most recent deletions of the last three months are hidden, so after more deletions than that the oldest ones' remaining traffic shows again. The R2 archive and the daily numbers in D1 still keep every link.

## Near-realtime page

::: tip Not a live stream
This page does **not** use WebSocket. It refreshes about every 10 seconds and plays new events at about one per second. Pause or a hidden tab stops playback. Treat it as a live-looking overview, not a perfect event feed.
:::

## Keeping analytics beyond three months

Cloudflare Analytics Engine keeps data for **three months**, then deletes it. On Workers deployments Sink copies every record to your R2 bucket before that happens:

- A cron trigger runs every 5 minutes and copies one UTC hour at a time, once the day is 2 days old.
- Files are stored as `analytics/raw/YYYY-MM-DD/HH.ndjson`, one JSON object per line, with every recorded field (including IP address and user agent) and Cloudflare's sampling weight `_sample_interval`.
- On its first runs it catches up from the day of the oldest record Analytics Engine holds, up to 90 days old, oldest first. Analytics Engine keeps 89 to 92 days, so in a short month the oldest of these days may already be partly deleted; whatever is left is kept.

It needs the same account ID and API token as analytics, plus the `R2` binding. Pages deployments have no cron triggers, so nothing is archived there.

::: warning Personal data
The archive keeps visitor IP addresses and user agents with no expiry. Keep the R2 bucket private, and remember these files when you answer a data deletion request.
:::

The same job also writes daily numbers per link to D1, once a day's hours are archived:

- `analytics_daily`: visits, visitors and referers per link and UTC day, computed as on the link cards.
- `analytics_daily_breakdown`: visits and visitors per link, UTC day and value of each dimension (referer, country, region, city, timezone, language, OS, browser, browser type, device, device type, Cloudflare data center).

The Analysis page reads the daily numbers for days older than 88 days, which Analytics Engine may already have deleted. For those days:

- Counters, the trend chart by day and the detail lists come from the daily numbers, by UTC day. Visits are exact; visitors and referers are sums of daily values, so they are estimates. A list that combines old and recent days is approximate, because each part keeps only its top values.
- The hourly chart and the weekly trend heatmap cover the last 3 months only.
- A day whose daily numbers are not written yet is shown as without data, never as zero. One view reads at most the 366 days before the last 88; earlier days are shown as without data too.
- To stay inside the free plan's D1 reads, these old-day reads stop for the day after reading 2,000,000 D1 rows; the page then says the older days are available again tomorrow.
- Where no daily numbers exist at all (Pages, or a Worker without R2), the page reads Analytics Engine as before.
- Filtering by link or slug works; other filters (API only) leave the old days out, and the answer's `history` field says so.
- Link cards, the CSV export, recent events, the globe and the MCP analytics tools read Analytics Engine only, as before.

The R2 archive is for download and offline analysis; the dashboard does not read it.

What the logs mean:

- `analytics_export.stopped`: Analytics Engine, the network, R2 or D1 failed. The run stops and the same step (an hour, or a day's numbers) is tried again 5 minutes later, so nothing is lost while the day is under 89 days old (the least Analytics Engine keeps). The log names the step, the status code and the error name.
- `analytics_export.hour_truncated`: the hour held more than 10,000 records, for example during a flood of requests. Its first 10,000 records are kept.
- `analytics_export.seed_failed`: the daily question for the oldest record Analytics Engine holds failed or got an unexpected answer, so no new day was added. The steps already added still run, and the next run asks again.
- `analytics_export.skipped_before_first_record`: steps of days before the oldest record were marked done without being asked for, because those days hold nothing.
- `analytics_export.write_budget`: the daily numbers wrote 50,000 D1 rows today, about half the free plan's daily writes, so they stop until the next UTC day. The archive goes on.
- `analytics_export.size_limit`, logged once an hour: the D1 database is over 400 MB, or D1 did not report its size, so the daily numbers stop. The archive goes on.
- `analytics_export.step_parked`: the answer for one step was wrong 3 times (for example fewer records than counted, a row that cannot be read, a page of values too long to store, or a rejected query for a later page of a day's numbers, whose query contains a recorded value), so that step is skipped. For an hour, whatever was received is kept in its file. To try parked steps again while they are under 89 days old, run:

```sh
npx wrangler d1 execute <database> --remote --command "UPDATE analytics_export_steps SET parked_at = NULL, attempts = 0 WHERE parked_at IS NOT NULL"
```

## Export

Download filtered stats as CSV from the dashboard or the stats export API (slug, URL, viewers, views, referrers).

Link JSON export is separate — see [Import and Export](./import-export).
