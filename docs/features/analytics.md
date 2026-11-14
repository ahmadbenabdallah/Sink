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

## Near-realtime page

::: tip Not a live stream
This page does **not** use WebSocket. It refreshes about every 10 seconds and plays new events at about one per second. Pause or a hidden tab stops playback. Treat it as a live-looking overview, not a perfect event feed.
:::

## Keeping analytics beyond three months

Cloudflare Analytics Engine keeps data for **three months**, then deletes it. On Workers deployments Sink copies every record to your R2 bucket before that happens:

- A cron trigger runs every 5 minutes and copies one UTC hour at a time, once the day is 2 days old.
- Files are stored as `analytics/raw/YYYY-MM-DD/HH.ndjson`, one JSON object per line, with every recorded field (including IP address and user agent) and Cloudflare's sampling weight `_sample_interval`.
- On its first runs it catches up on every day up to 85 days old, oldest first.

It needs the same account ID and API token as analytics, plus the `R2` binding. Pages deployments have no cron triggers, so nothing is archived there.

::: warning Personal data
The archive keeps visitor IP addresses and user agents with no expiry. Keep the R2 bucket private, and remember these files when you answer a data deletion request.
:::

The dashboard does not read the archive yet; it is for download and offline analysis.

What the logs mean:

- `analytics_export.stopped`: Analytics Engine, the network or R2 failed. The run stops and the same hour is tried again 5 minutes later, so nothing is lost while the day is under 85 days old. The log names the hour, the status code and the error name.
- `analytics_export.hour_truncated`: the hour held more than 10,000 records, for example during a flood of requests. Its first 10,000 records are kept.
- `analytics_export.step_parked`: the answer for one hour was wrong 3 times (for example fewer records than counted), so that hour is skipped. Whatever was received is kept in its file. To try parked hours again while they are under 85 days old, run:

```sh
npx wrangler d1 execute <database> --remote --command "UPDATE analytics_export_steps SET parked_at = NULL, attempts = 0 WHERE parked_at IS NOT NULL"
```

## Export

Download filtered stats as CSV from the dashboard or the stats export API (slug, URL, viewers, views, referrers).

Link JSON export is separate — see [Import and Export](./import-export).
