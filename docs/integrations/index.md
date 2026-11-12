---
title: Integrations
description: Connect Sink to AI coding tools through its built-in MCP server, plus browser extensions, Raycast, Apple Shortcuts, and iOS.
---

# Integrations

Sink exposes an authenticated REST API and generated OpenAPI document for automation. The following projects and recipes provide convenient entry points; review third-party code and credential handling before use.

## AI Skills

Install the repository's AI Skills package with:

```sh
npx skills add miantiao-me/sink
```

## MCP Server

Sink serves a Model Context Protocol endpoint at `POST /api/mcp`. It uses the official [`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server) SDK v2 entry point, serving modern clients over the per-request transport and 2025-era clients over the stateless fallback, so current MCP clients work without extra configuration and older protocol versions stay compatible through the SDK's own version negotiation. A client on protocol version 2025-11-25 or earlier receives each answer as a server-sent event stream (`text/event-stream`); a newer client receives JSON.

Connect from a command-line, desktop or server-side client. A request from a web page on another site is refused with HTTP 403, so MCP clients that run in a browser page are not supported.

The endpoint accepts a [connector token](#connector-tokens), which is the recommended credential for an agent, or the site token that the REST API uses. See [API authentication](/api/#authentication).

```sh
claude mcp add --transport http sink https://your-domain/api/mcp --header "Authorization: Bearer YOUR_SITE_TOKEN"
```

Any client that supports an HTTP transport with custom headers can connect the same way:

```json
{
  "mcpServers": {
    "sink": {
      "type": "http",
      "url": "https://your-domain/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SITE_TOKEN"
      }
    }
  }
}
```

### Connector tokens

A connector token is a credential for the MCP endpoint only. Use one per agent, so the dashboard password never sits in an agent's configuration, and so one agent can be cut off without affecting the others.

Each token has a level:

| Level    | The agent can                                          |
| -------- | ------------------------------------------------------ |
| `read`   | Read links and analytics.                              |
| `create` | Also create links.                                     |
| `full`   | Also change and delete links, and check their targets. |

Create one in the dashboard under **Settings → Connectors**, which also lists each connector's usage and lets you revoke it. The same can be done through the API with the site token. The token is shown in this response only:

```sh
curl -X POST https://your-domain/api/connector/create \
  -H "Authorization: Bearer YOUR_SITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Claude Code","level":"read"}'
```

Then connect the agent with it:

```sh
claude mcp add --transport http sink https://your-domain/api/mcp --header "Authorization: Bearer sink_mcp_..."
```

`GET /api/connector/list` lists connectors, and `POST /api/connector/revoke` with `{"id":"..."}` revokes one; a revoked token is refused from the next request on. A connector token works on `/api/mcp` only: it cannot call the REST API, sign in to the dashboard, or manage connectors.

Each connector may make 5,000 tool calls per UTC day; `GET /api/connector/list` shows the calls of the last seven days and when each connector was last used. See [MCP usage and the D1 write quota](/deployment/workers#mcp-usage-and-the-d1-write-quota) to change the limit.

Once every agent uses a connector token, set `NUXT_MCP_ALLOW_SITE_TOKEN=false` so the site token is no longer accepted on `/api/mcp`.

::: warning
Connectors outlive a change of `NUXT_SITE_TOKEN`. If the site token may have leaked, change it and also review the connector list, revoking any you do not recognise.

With [Cloudflare Access](/configuration/cloudflare-access) in front of Sink, a request that carries an Access identity has every right whatever token it also sends, so a level restricts only callers that reach Sink without one.
:::

### Tools

An agent sees only the tools its level allows. A tool above the level is not listed and cannot be called.

| Tool                     | Level    | Description                                                           |
| ------------------------ | -------- | --------------------------------------------------------------------- |
| `list_links`             | `read`   | List links newest first, with cursor pagination.                      |
| `search_links`           | `read`   | Search links by keyword or destination URL.                           |
| `get_link`               | `read`   | Read a single link by slug.                                           |
| `count_links`            | `read`   | Count links matching a keyword, URL, tag, or status.                  |
| `list_tags`              | `read`   | List tags in use and how many links carry each.                       |
| `get_analytics_counters` | `read`   | Total visits, visitors, and referers.                                 |
| `get_analytics_views`    | `read`   | Visits and visitors bucketed by minute, hour, or day.                 |
| `get_analytics_metrics`  | `read`   | Top values for one access-log dimension.                              |
| `get_analytics_heatmap`  | `read`   | Visits and visitors by weekday and hour of day.                       |
| `create_link`            | `create` | Create a link, generating a slug when none is given.                  |
| `upsert_link`            | `create` | Return the existing link for a slug, or create it.                    |
| `update_link`            | `full`   | Change the fields sent; the others are kept.                          |
| `delete_link`            | `full`   | Permanently delete a link.                                            |
| `check_links`            | `full`   | Fetch stored link targets and report their status, paginated by slug. |

The site token, where it is accepted on the MCP endpoint, and a Cloudflare Access identity have every tool.

::: warning Visitor data reaches the agent
Analytics values such as referers, languages and browser names come from your visitors, and link comments, titles and descriptions come from whoever created the link. An agent reads them as part of its input. Sink tells the agent to treat them as data and filters values that do not have the expected shape, but no wording makes text safe for a model to read.

Give an agent that reads analytics a `read` token, so that nothing it reads can lead it to change or delete a link.
:::

The write tools honor `NUXT_PUBLIC_PREVIEW_MODE` and the KV-to-D1 migration gate exactly as the REST API does, and analytics tools read the same sampled access log as the dashboard, so their counts are estimates. `update_link` changes only the fields it is sent: a field that is left out is kept, and `null` removes it. `tags` and `geo` are replaced as a whole, and `null` or an empty `password` clears protection. When the URL changes and `unsafe` is not sent, a stored warning is kept.

The endpoint sits under `/api/` so it stays out of the short-link namespace: a slug cannot contain a slash, so no link can shadow it and no reserved slug is needed. Upgrading never takes a slug away from an instance that already uses one.

### Upgrading from an earlier version

Connector tokens, levels and usage counting arrived together with stricter tool inputs. The requests and answers of the REST routes for links and analytics did not change, and neither did click recording. The last two rows below apply to REST clients and the dashboard as well as to MCP.

| What                            | Before                                                                          | Now                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown tool arguments          | Ignored silently, except by `check_links`.                                      | Refused, with a message naming the argument.                                                                                                                                                   |
| `create_link`, `upsert_link`    | Accepted `id`, `createdAt` and `updatedAt`.                                     | Refuse them; the server sets all three.                                                                                                                                                        |
| `list_links`, `search_links`    | Up to 1,000 results per call, 20 by default.                                    | Up to 100 per call, 20 by default. A larger `limit` is refused. `list_links` continues with its cursor; `search_links` has none, so narrow the search.                                         |
| `get_analytics_metrics` limit   | Up to 500 rows per call, and 500 when `limit` was not sent.                     | Up to 100 per call, and 20 when `limit` is not sent. A larger `limit` is refused. There is no cursor: only the top 100 values can be read.                                                     |
| `get_analytics_metrics`         | Any access-log dimension.                                                       | The types `ua`, `ip` and `device` are not offered. A referer, language, browser or operating system name with an unexpected shape is reported under a fixed label such as `(other)`.           |
| Analytics tools                 | Accepted a period that ends before it starts.                                   | Refuse it.                                                                                                                                                                                     |
| `update_link`                   | Replaced the link: an optional field left out was removed, except the password. | Changes only the fields sent; `null` removes a field.                                                                                                                                          |
| `delete_link`                   | Always answered `deleted: true`.                                                | Answers `deleted: false` when no link had that slug.                                                                                                                                           |
| `search_links`                  | Returned each URL without its query string.                                     | Returns the stored URL. The `url` filter still ignores the query string.                                                                                                                       |
| JSON-RPC batches                | Processed for 2025-era clients.                                                 | Refused with HTTP 400. Send one request per call.                                                                                                                                              |
| Tool calls                      | Unlimited.                                                                      | 5,000 per caller per UTC day; see `NUXT_MCP_DAILY_CALL_LIMIT`. Past it, a tool call answers with an error until 00:00 UTC. The site token counts as one caller, and so does Cloudflare Access. |
| Every `/api/` route, on Workers | No request limit.                                                               | About 1,200 requests per minute per client address (an IPv6 /64 counts as one), then HTTP 429 with `Retry-After: 60`.                                                                          |
| An empty `NUXT_SITE_TOKEN`      | A request without credentials was accepted as the owner.                        | The site token matches nothing, so nobody can sign in with it. Connector tokens and Cloudflare Access still work. Set a long random token.                                                     |

To move your agents to connector tokens:

1. Deploy this version. Deploying applies the two new D1 migrations, which add the connector and usage tables: on Workers through `pnpm deploy:worker`, on Pages through the build of the `master` branch.
2. In the dashboard, open **Settings → Connectors** and create one connector per agent, with the lowest level that agent needs.
3. In each agent's configuration, replace the site token with its connector token.
4. Set `NUXT_MCP_ALLOW_SITE_TOKEN=false` and deploy again. The site token then works for the dashboard and the REST API only.
5. Change `NUXT_SITE_TOKEN`, because the old value has been stored in agent configurations.

## OpenAPI to MCP

An OpenAPI proxy is an alternative when a client cannot reach the built-in endpoint, for example because it only supports stdio servers.

Requires [`uv`](https://github.com/astral-sh/uv) so the `uvx` command is available:

```json
{
  "mcpServers": {
    "sink": {
      "command": "uvx",
      "args": ["mcp-openapi-proxy"],
      "env": {
        "OPENAPI_SPEC_URL": "https://your-domain/_docs/openapi.json",
        "API_KEY": "YOUR_SITE_TOKEN",
        "TOOL_WHITELIST": "/api/link"
      }
    }
  }
}
```

Use your own instance URL and site token. Restrict the exposed route set to the operations the client needs, and protect the client configuration as a secret. See [API authentication](/api/#authentication).

## Apps and extensions

- [Sink Tool browser extension](https://github.com/zhuzhuyule/sink-extension)
- [Sink Quick Shorten for Chrome](https://chromewebstore.google.com/detail/sink-quick-shorten/emlojomjpenjgkaphajcokijobpkejih)
- [Raycast-Sink](https://github.com/foru17/raycast-sink)
- [Sink Apple Shortcuts](https://s.search1api.com/sink001)
- [Sink for iOS](https://apps.apple.com/app/id6745417598)

These integrations may be maintained independently of the core Sink repository. Confirm their compatibility with your deployed API version in your instance's [OpenAPI reference](/api/).
