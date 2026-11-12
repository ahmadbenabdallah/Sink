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

Sink serves a Model Context Protocol endpoint at `POST /api/mcp`. It uses the official [`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server) SDK v2 entry point, serving modern clients over the per-request transport and 2025-era clients over the stateless fallback with JSON responses, so current MCP clients work without extra configuration and older protocol versions stay compatible through the SDK's own version negotiation.

The endpoint authenticates with the same bearer token as the REST API, so no separate credential is needed. See [API authentication](/api/#authentication).

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

| Tool                     | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| `list_links`             | List links newest first, with cursor pagination.      |
| `search_links`           | Search links by keyword or exact destination URL.     |
| `get_link`               | Read a single link by slug.                           |
| `count_links`            | Count links matching a keyword, URL, tag, or status.  |
| `list_tags`              | List tags in use and how many links carry each.       |
| `create_link`            | Create a link, generating a slug when none is given.  |
| `update_link`            | Change the fields sent; the others are kept.          |
| `upsert_link`            | Return the existing link for a slug, or create it.    |
| `delete_link`            | Permanently delete a link.                            |
| `check_links`            | Check stored link targets, paginated by slug.         |
| `get_analytics_counters` | Total visits, visitors, and referers.                 |
| `get_analytics_views`    | Visits and visitors bucketed by minute, hour, or day. |
| `get_analytics_metrics`  | Top values for one access-log dimension.              |
| `get_analytics_heatmap`  | Visits and visitors by weekday and hour of day.       |

The write tools honor `NUXT_PUBLIC_PREVIEW_MODE` and the KV-to-D1 migration gate exactly as the REST API does, and analytics tools read the same sampled access log as the dashboard, so their counts are estimates. `update_link` changes only the fields it is sent: a field that is left out is kept, and `null` removes it. `tags` and `geo` are replaced as a whole, and `null` or an empty `password` clears protection. When the URL changes and `unsafe` is not sent, a stored warning is kept.

The endpoint sits under `/api/` so it stays out of the short-link namespace: a slug cannot contain a slash, so no link can shadow it and no reserved slug is needed. Upgrading never takes a slug away from an instance that already uses one.

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
