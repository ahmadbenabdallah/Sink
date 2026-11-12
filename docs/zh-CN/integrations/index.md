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

Sink 在 `POST /api/mcp` 提供 Model Context Protocol 端点。它基于官方 [`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server) SDK v2 入口：新协议客户端走逐请求传输，2025 版旧客户端走无状态兼容回退（JSON 响应），均无需额外配置即可使用。

该端点使用与 REST API 相同的 Bearer 令牌进行认证，无需单独的凭据。详见 [API 身份认证](/zh-CN/api/#身份认证)。

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

使用站点令牌创建。令牌只会在这次响应中出现一次：

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

当所有代理都改用连接器令牌后，设置 `NUXT_MCP_ALLOW_SITE_TOKEN=false`，`/api/mcp` 将不再接受站点令牌。

::: warning
更换 `NUXT_SITE_TOKEN` 不会使已有的连接器失效。如果站点令牌可能已泄露，请更换它，并检查连接器列表，撤销所有不认识的连接器。

如果 Sink 前面启用了 [Cloudflare Access](/configuration/cloudflare-access)，携带 Access 身份的请求无论同时发送什么令牌都拥有全部权限，因此级别只对不经过 Access 的调用方生效。
:::

### 工具

| 工具                     | 说明                                        |
| ------------------------ | ------------------------------------------- |
| `list_links`             | 按最新优先列出链接，支持游标分页。          |
| `search_links`           | 按关键字或精确目标 URL 搜索链接。           |
| `get_link`               | 按 slug 读取单个链接。                      |
| `count_links`            | 统计匹配关键字、URL、标签或状态的链接数量。 |
| `list_tags`              | 列出正在使用的标签及其链接数量。            |
| `create_link`            | 创建链接，未提供 slug 时自动生成。          |
| `update_link`            | 只修改传入的字段，其余字段保持不变。        |
| `upsert_link`            | 返回该 slug 的现有链接，不存在时创建。      |
| `delete_link`            | 永久删除链接。                              |
| `check_links`            | 按 slug 分页检查已存链接的目标 URL。        |
| `get_analytics_counters` | 总访问量、访客数与来源数。                  |
| `get_analytics_views`    | 按分钟、小时或天分桶的访问量与访客数。      |
| `get_analytics_metrics`  | 某个访问日志维度的 Top 值。                 |
| `get_analytics_heatmap`  | 按星期几和小时分桶的访问量与访客数。        |

写入类工具与 REST API 一样遵循 `NUXT_PUBLIC_PREVIEW_MODE` 和 KV 到 D1 的迁移门控；分析类工具读取与仪表盘相同的采样访问日志，因此结果为估算值。`update_link` 只修改传入的字段：省略的字段保持不变，传 `null` 则移除该字段。`tags` 和 `geo` 会整体替换，`password` 传 `null` 或空字符串会清除访问密码。URL 变更且未传 `unsafe` 时，已有的不安全警告会保留。

该端点位于 `/api/` 之下，因此不占用短链接命名空间：slug 不能包含斜杠，所以没有短链接会遮蔽它，也无需保留 slug。升级不会夺走实例上已在使用的任何 slug。

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
