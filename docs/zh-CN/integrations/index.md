---
title: 集成
description: 通过内置 MCP Server 将 Sink 连接到 AI 编码工具，以及浏览器扩展、Raycast、Apple 快捷指令和 iOS。
---

# 集成

Sink 提供已认证的 REST API 和自动生成的 OpenAPI 文档，便于自动化操作。以下项目和示例提供了便捷的入口；使用前请检查第三方代码及其凭据处理方式。

## AI Skills

使用以下命令安装仓库的 AI Skills 包：

```sh
npx skills add miantiao-me/sink
```

## MCP Server

Sink 在 `POST /api/mcp` 提供 Model Context Protocol 端点。它基于官方 [`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server) SDK v2 入口：新协议客户端走逐请求传输，2025 版旧客户端走无状态兼容回退，均无需额外配置即可使用。协议版本为 2025-11-25 或更早的客户端收到的每个响应都是服务器发送事件流（`text/event-stream`），更新的客户端收到 JSON。

请使用命令行、桌面或服务端客户端连接。来自其他站点网页的请求会以 HTTP 403 拒绝，因此不支持在浏览器页面中运行的 MCP 客户端。

该端点接受[连接器令牌](#连接器令牌)（推荐代理使用），也接受 REST API 使用的站点令牌。详见 [API 身份认证](/zh-CN/api/#身份认证)。

```sh
claude mcp add --transport http sink https://your-domain/api/mcp --header "Authorization: Bearer YOUR_SITE_TOKEN"
```

任何支持 HTTP 传输与自定义请求头的客户端都可以用同样的方式连接：

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

### 连接器令牌

连接器令牌是仅用于 MCP 端点的凭据。为每个代理单独创建一个，这样仪表盘密码就不会出现在代理的配置里，也可以单独停用某个代理而不影响其他代理。

每个令牌都有一个级别：

| 级别     | 代理可以                               |
| -------- | -------------------------------------- |
| `read`   | 读取链接和分析数据。                   |
| `create` | 还可以创建链接。                       |
| `full`   | 还可以修改、删除链接，并检查链接目标。 |

可以在仪表盘的 **设置 → 连接器** 中创建，那里还会显示每个连接器的用量，并可撤销连接器。也可以使用站点令牌通过 API 完成同样的操作。令牌只会在这次响应中出现一次：

```sh
curl -X POST https://your-domain/api/connector/create \
  -H "Authorization: Bearer YOUR_SITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Claude Code","level":"read"}'
```

然后用它连接代理：

```sh
claude mcp add --transport http sink https://your-domain/api/mcp --header "Authorization: Bearer sink_mcp_..."
```

`GET /api/connector/list` 列出连接器，`POST /api/connector/revoke`（请求体 `{"id":"..."}`）撤销连接器；被撤销的令牌从下一次请求起即被拒绝。连接器令牌只能用于 `/api/mcp`：不能调用 REST API、不能登录仪表盘，也不能管理连接器。

每个连接器每个 UTC 日最多可进行 5,000 次工具调用；`GET /api/connector/list` 会显示最近七天的调用次数以及每个连接器最近一次使用的时间。调整上限请参阅 [MCP 用量与 D1 写入配额](/zh-CN/deployment/workers#mcp-用量与-d1-写入配额)。

当所有代理都改用连接器令牌后，设置 `NUXT_MCP_ALLOW_SITE_TOKEN=false`，`/api/mcp` 将不再接受站点令牌。

::: warning
更换 `NUXT_SITE_TOKEN` 不会使已有的连接器失效。如果站点令牌可能已泄露，请更换它，并检查连接器列表，撤销所有不认识的连接器。

如果 Sink 前面启用了 [Cloudflare Access](/configuration/cloudflare-access)，携带 Access 身份的请求无论同时发送什么令牌都拥有全部权限，因此级别只对不经过 Access 的调用方生效。
:::

### 工具

代理只能看到其级别允许的工具。高于该级别的工具不会列出，也无法调用。

| 工具                     | 级别     | 说明                                                |
| ------------------------ | -------- | --------------------------------------------------- |
| `list_links`             | `read`   | 按最新优先列出链接，支持游标分页。                  |
| `search_links`           | `read`   | 按关键字或目标 URL 搜索链接。                       |
| `get_link`               | `read`   | 按 slug 读取单个链接。                              |
| `count_links`            | `read`   | 统计匹配关键字、URL、标签或状态的链接数量。         |
| `list_tags`              | `read`   | 列出正在使用的标签及其链接数量。                    |
| `get_analytics_counters` | `read`   | 总访问量、访客数与来源数。                          |
| `get_analytics_views`    | `read`   | 按分钟、小时或天分桶的访问量与访客数。              |
| `get_analytics_metrics`  | `read`   | 某个访问日志维度的 Top 值。                         |
| `get_analytics_heatmap`  | `read`   | 按星期几和小时分桶的访问量与访客数。                |
| `create_link`            | `create` | 创建链接，未提供 slug 时自动生成。                  |
| `upsert_link`            | `create` | 返回该 slug 的现有链接，不存在时创建。              |
| `update_link`            | `full`   | 只修改传入的字段，其余字段保持不变。                |
| `delete_link`            | `full`   | 永久删除链接。                                      |
| `check_links`            | `full`   | 请求已存链接的目标 URL 并报告其状态，按 slug 分页。 |

站点令牌（在 MCP 端点接受它时）和 Cloudflare Access 身份拥有全部工具。

::: warning 访客数据会进入代理
来源、语言、浏览器名称等分析值来自访客；链接的备注、标题和描述来自创建链接的人。代理会把它们当作输入的一部分读取。Sink 会告知代理将其视为数据，并过滤形状不符合预期的值，但任何措辞都无法让文本对模型而言变得安全。

请给读取分析数据的代理使用 `read` 令牌，这样它读到的任何内容都无法让它修改或删除链接。
:::

写入类工具与 REST API 一样遵循 `NUXT_PUBLIC_PREVIEW_MODE` 和 KV 到 D1 的迁移门控；分析类工具读取与仪表盘相同的采样访问日志，因此结果为估算值。`update_link` 只修改传入的字段：省略的字段保持不变，传 `null` 则移除该字段。`tags` 和 `geo` 会整体替换，`password` 传 `null` 或空字符串会清除访问密码。URL 变更且未传 `unsafe` 时，已有的不安全警告会保留。

该端点位于 `/api/` 之下，因此不占用短链接命名空间：slug 不能包含斜杠，所以没有短链接会遮蔽它，也无需保留 slug。升级不会夺走实例上已在使用的任何 slug。

### 从旧版本升级

连接器令牌、级别和用量统计与更严格的工具输入一同推出。链接和分析的 REST 路由的请求与响应未变，点击记录也未变。下表最后两行同样适用于 REST 客户端和仪表盘。

| 项目                             | 之前                                            | 现在                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未知的工具参数                   | 被静默忽略（`check_links` 除外）。              | 被拒绝，并在消息中指出该参数。                                                                                                                                 |
| `create_link`、`upsert_link`     | 接受 `id`、`createdAt` 和 `updatedAt`。         | 拒绝这些字段，三者均由服务器设置。                                                                                                                             |
| `list_links`、`search_links`     | 每次调用最多 1,000 条，默认 20 条。             | 每次调用最多 100 条，默认 20 条。更大的 `limit` 会被拒绝。`list_links` 可用游标继续；`search_links` 没有游标，请缩小搜索范围。                                 |
| `get_analytics_metrics` 的 limit | 每次调用最多 500 行，未传 `limit` 时为 500 行。 | 每次调用最多 100 行，未传 `limit` 时为 20 行。更大的 `limit` 会被拒绝。没有游标，只能读取前 100 个值。                                                         |
| `get_analytics_metrics`          | 任意访问日志维度。                              | 不再提供 `ua`、`ip` 和 `device` 类型。形状不符合预期的来源、语言、浏览器或操作系统名称会归入固定标签，例如 `(other)`。                                         |
| 分析类工具                       | 接受结束早于开始的时间段。                      | 拒绝。                                                                                                                                                         |
| `update_link`                    | 替换整个链接：省略的可选字段被移除，密码除外。  | 只修改传入的字段；传 `null` 移除字段。                                                                                                                         |
| `delete_link`                    | 始终返回 `deleted: true`。                      | 该 slug 没有链接时返回 `deleted: false`。                                                                                                                      |
| `search_links`                   | 返回的 URL 不含查询字符串。                     | 返回存储的 URL。`url` 过滤条件仍忽略查询字符串。                                                                                                               |
| JSON-RPC 批量请求                | 2025 版客户端的批量请求会被处理。               | 以 HTTP 400 拒绝。请每次调用只发送一个请求。                                                                                                                   |
| 工具调用                         | 不限次数。                                      | 每个调用方每个 UTC 日 5,000 次，见 `NUXT_MCP_DAILY_CALL_LIMIT`。超出后工具调用返回错误，直到 00:00 UTC。站点令牌算作一个调用方，Cloudflare Access 也算作一个。 |
| Workers 上的所有 `/api/` 路由    | 无请求限制。                                    | 每个客户端地址每分钟约 1,200 次请求（一个 IPv6 /64 算作一个地址），之后返回 HTTP 429 和 `Retry-After: 60`。                                                    |
| 空的 `NUXT_SITE_TOKEN`           | 不带凭据的请求会被当作所有者接受。              | 站点令牌不匹配任何请求，因此无法用它登录。连接器令牌和 Cloudflare Access 仍然有效。请设置一个足够长的随机令牌。                                                |

将代理迁移到连接器令牌：

1. 部署此版本。部署会执行两个新的 D1 迁移，添加连接器表和用量表：Workers 通过 `pnpm deploy:worker`，Pages 通过 `master` 分支的构建。
2. 在仪表盘中打开 **设置 → 连接器**，为每个代理创建一个连接器，级别取该代理所需的最低级别。
3. 在每个代理的配置中，用其连接器令牌替换站点令牌。
4. 设置 `NUXT_MCP_ALLOW_SITE_TOKEN=false` 并重新部署。此后站点令牌只用于仪表盘和 REST API。
5. 更换 `NUXT_SITE_TOKEN`，因为旧值曾保存在代理配置中。

## OpenAPI 转 MCP

当客户端无法访问内置端点时（例如仅支持 stdio 服务端），可以改用 OpenAPI 代理。

需要先安装 [`uv`](https://github.com/astral-sh/uv)，以便使用 `uvx` 命令：

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

使用你自己的实例 URL 和站点令牌。将公开的路由范围限制为客户端所需的操作，并将客户端配置作为密钥保护。详见 [API 身份认证](/zh-CN/api/#身份认证)。

## 应用与扩展

- [Sink Tool 浏览器扩展](https://github.com/zhuzhuyule/sink-extension)
- [Sink Quick Shorten for Chrome](https://chromewebstore.google.com/detail/sink-quick-shorten/emlojomjpenjgkaphajcokijobpkejih)
- [Raycast-Sink](https://github.com/foru17/raycast-sink)
- [Sink Apple 快捷指令](https://s.search1api.com/sink001)
- [Sink for iOS](https://apps.apple.com/app/id6745417598)

这些集成可能独立于 Sink 核心仓库维护。请通过实例的 [OpenAPI 参考](/zh-CN/api/)确认其与你部署的 API 版本兼容。
