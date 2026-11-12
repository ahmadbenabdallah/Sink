---
title: 部署到 Cloudflare Workers
description: 通过 Git 集成将 Sink 部署到 Cloudflare Workers。
---

# 部署到 Cloudflare Workers

## 1. Fork Sink 并创建资源

[Fork Sink 仓库](https://github.com/miantiao-me/Sink/fork)。在 [Cloudflare 仪表盘](https://dash.cloudflare.com/) 中创建：

| 绑定名称    | 产品                    | 是否必需 | 说明           |
| ----------- | ----------------------- | -------- | -------------- |
| `DB`        | D1 数据库               | 必需     | 保存链接       |
| `KV`        | KV 命名空间             | 必需     | 加速跳转       |
| `ANALYTICS` | Analytics Engine 数据集 | 推荐     | 访问统计       |
| `R2`        | R2 存储桶               | 可选     | 备份与社交图片 |
| `AI`        | Workers AI              | 可选     | AI 建议        |

在 D1、KV 各自的详情页复制 **数据库 ID** 和 **命名空间 ID**。

访问分析是可选的——不配也能用短链。启用步骤见[访问分析与近实时视图](/zh-CN/features/analytics)。

## 2. 连接 Git（Workers Builds）

在 Cloudflare 仪表盘中创建带 **Git 集成** 的 Worker，并连接你的 Fork：

- **生产分支：** `master`
- **构建命令：** `pnpm build`
- **部署命令：** `pnpm deploy:worker`

添加这些**构建变量**（**不要**把生产环境 ID 写进仓库里的 `wrangler.jsonc` — 请用 `DEPLOY_*`）：

| 变量                             | 填什么                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `DEPLOY_D1_DATABASE_ID`          | D1 数据库 ID（在 D1 详情页）                                                      |
| `DEPLOY_KV_NAMESPACE_ID`         | KV 命名空间 ID（在 KV 详情页）→ `kv_namespaces[].id`                              |
| `DEPLOY_KV_PREVIEW_NAMESPACE_ID` | 可选 Wrangler 预览 KV → `preview_id`（默认等于 `DEPLOY_KV_NAMESPACE_ID`）         |
| `DEPLOY_R2_BUCKET_NAME`          | R2 存储桶名称（仅在使用 R2 时；不填则生成配置里不含 R2）→ `bucket_name`           |
| `DEPLOY_R2_PREVIEW_BUCKET_NAME`  | 可选 Wrangler 预览 R2 → `preview_bucket_name`（默认等于 `DEPLOY_R2_BUCKET_NAME`） |
| `DEPLOY_D1_DATABASE_NAME`        | 可选；默认 `sink`                                                                 |
| `DEPLOY_ANALYTICS_DATASET`       | 可选；默认 `sink`（若改了，请与 `NUXT_DATASET` 保持一致）                         |

`pnpm deploy:worker` 会根据这些值生成被 gitignore 的 `wrangler.deploy.jsonc`，更新 D1 结构后部署。连接仓库时 Cloudflare 会生成部署令牌 — 不用再单独粘贴部署密钥。

## 3. 应用设置（登录密码等）

在 **Settings → Variables and Secrets** 中添加：

| 变量                 | 类型     | 用途                                                               |
| -------------------- | -------- | ------------------------------------------------------------------ |
| `NUXT_SITE_TOKEN`    | 加密密钥 | 仪表盘登录密码和 API 密码（至少 8 个字符且不含空白字符，保持稳定） |
| `NUXT_CF_ACCOUNT_ID` | 变量     | 访问分析推荐                                                       |
| `NUXT_CF_API_TOKEN`  | 加密密钥 | 访问分析推荐                                                       |

访问分析细节见[访问分析与近实时视图](/zh-CN/features/analytics)。完整列表见[配置参考](/zh-CN/configuration/)。

确认绑定名称正好是 `DB`、`KV`、`ANALYTICS`、`R2`、`AI`。

### MCP 用量与 D1 写入配额

如果通过 [MCP 端点](/zh-CN/integrations/#mcp-server)连接 AI 代理，Sink 会统计它们的工具调用次数，以便仪表盘展示每个连接器的用量。每次被统计的调用会向 D1 写入一行。

Cloudflare 免费计划每天允许 100,000 次 D1 行写入，并与创建、编辑链接共用。为避免某个繁忙的代理把配额用完，每个调用方每个 UTC 日最多可进行 5,000 次工具调用。超出后，该调用方的工具调用会被拒绝并返回提示，直到 UTC 00:00；其他调用方不受影响。

一个连接器令牌就是一个调用方。站点令牌算作一个调用方，Cloudflare Access 也算作一个：所有通过 Access 访问 MCP 的用户共用同一份额度，使用站点令牌的代理也会消耗其他使用站点令牌者的额度。请为每个代理单独创建连接器令牌。

可通过 `NUXT_MCP_DAILY_CALL_LIMIT` 调整：

- 使用付费 Workers 计划时，可以调高。
- 在免费计划上有很多活跃连接器时，应调低：十个调用方各用满 5,000 次就会占用每日配额的一半。

该上限是按 D1 配额设定的。创建或编辑链接还会写入 KV，免费计划每天允许 1,000 次 KV 写入，因此只创建链接的调用方可能远在达到调用上限之前就先用完 KV 配额。

## 4. 部署并首次使用

从 `master` 启动构建，等待完成。

1. 打开 `/dashboard`，用 `NUXT_SITE_TOKEN` 登录
2. 打开一次 **Dashboard → Links**（一次性存储初始化）
3. 创建链接

::: tip 必须先打开一次 Links
存储初始化完成前，创建链接可能失败，并提示「存储未就绪」（HTTP 423）。
:::

后续升级见[升级 Sink](./upgrading)。
