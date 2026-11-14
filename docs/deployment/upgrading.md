---
title: Upgrading Sink
description: Upgrade Sink by syncing your GitHub fork and redeploying.
---

# Upgrading Sink

## Before you upgrade

1. Skim the upstream release notes
2. Do not delete your Cloudflare bindings, secrets, or env vars
3. If R2 is set up, consider a manual [backup](/features/backups)

## Normal upgrade (current D1 installs)

1. On GitHub, open your fork → click **Sync fork** to pull the latest `master`. If you changed files yourself, resolve conflicts first
2. In Cloudflare (Workers Builds or Pages), redeploy the updated `master` branch
3. Wait for the deploy to finish (database updates run as part of deploy)

## Upgrading a very old install (links only in KV)

If your instance stored links only in KV (older Sink versions), keep that KV data and follow [storage setup / migration](/storage/kv-to-d1).

## Link targets must be web addresses

New and edited links take only `http://` and `https://` targets, in the main URL, the App Store and Play Store URLs and every geo URL. This applies to the dashboard, the API, import and MCP. A target such as `javascript:` or `data:` would run as script on your short-link domain.

Links saved before this change keep working and can still be listed, exported and deleted. Their visitors get a plain redirect, never the cloaking or preview page, and the dashboard shows their target without a clickable link. To edit one, change its target to an `http://` or `https://` address. An import file that contains one is refused, and the error names the row.

## After upgrade — quick check

- Sign in to the dashboard
- Open **Dashboard → Links** once (finishes storage setup if needed)
- Create, open, edit, and delete a test link
- Check analytics if you use it
