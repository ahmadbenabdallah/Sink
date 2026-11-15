---
title: 访问分析与近实时视图
description: 启用访问分析、查看图表和日志、了解近实时视图、排除机器人并导出 CSV。
---

# 访问分析与近实时视图

访问分析是**可选**功能。不配置时，短链、登录和链接管理仍可用 — 图表、日志和近实时视图会是空的。

## 如何启用（三样都要）

需要同时具备：

1. **Analytics Engine 绑定**，名称必须是 `ANALYTICS`
   - **Workers：** 通常由部署配置生成（数据集默认 `sink`）
   - **Pages：** **Settings → Bindings → Add → Analytics Engine**
   - 变量名：`ANALYTICS`
   - 数据集：默认 `sink`。若设置了 `NUXT_DATASET`，这里必须相同

2. **账户 ID** — 把 `NUXT_CF_ACCOUNT_ID` 设为承载本应用的 Cloudflare 账户 ID  
   （仪表盘侧边栏账户名，或登录后 URL 里可见）

3. **API 令牌** — 把 `NUXT_CF_API_TOKEN` 设为加密密钥：
   - Cloudflare 仪表盘 → 右上角头像 → **My Profile** → **API Tokens** → **Create Token** → **Custom Token**
   - 权限仅需：**Account → Account Analytics → Read**
   - 建议限制到同一账户

缺一或名称不一致，访问分析会一直为空。

## 能看到什么

成功的访问会进入计数器、图表、热力图、最近事件和位置。可按链接、时间、国家/地区、浏览器、系统、设备、来源筛选。

数字可能是**近似值**（Cloudflare 会对大流量采样）。低流量时也可能看起来不均匀。

要从统计和[点击 Webhook](/zh-CN/configuration/webhooks) 排除机器人，设置 `NUXT_DISABLE_BOT_ACCESS_LOG=true`。

**已删除的链接会被隐藏。** 你删除链接后（通过仪表盘、API 或 MCP `delete_link` 工具），它的流量会从所有图表、列表、导出和 MCP 分析结果中消失。重用同一短链码的新链接从零开始。通过导入恢复链接（导入会保留 ID）会找回它的历史数据。由[过期链接清理](/zh-CN/configuration/)自动删除的链接会保留历史；在此版本之前删除的链接，会一直显示到 Analytics Engine 的数据过期。只会隐藏最近三个月内最近的 2,000 次删除；删除次数超过这个数量后，最早删除的链接剩余的流量会重新显示。R2 归档和 D1 中的每日数据仍会保留所有链接。

## 近实时页面

::: tip 不是真正的实时流
这个页面**不用** WebSocket。大约每 10 秒刷新一次，并以大约每秒 1 个事件回放。暂停或标签页隐藏会停止回放。请当作“看起来像实时”的概览，而不是完整事件流。
:::

## 保留三个月以上的访问数据

Cloudflare Analytics Engine 只保留**三个月**的数据，之后会删除。在 Workers 部署中，Sink 会在删除前把每条记录复制到你的 R2 存储桶：

- 一个每 5 分钟运行的定时触发器，每次复制一个 UTC 小时的数据，只处理已满 2 天的日期。
- 文件保存为 `analytics/raw/YYYY-MM-DD/HH.ndjson`，每行一个 JSON 对象，包含所有记录字段（包括 IP 地址和 User-Agent）以及 Cloudflare 的采样权重 `_sample_interval`。
- 首次运行时，会按从旧到新的顺序补齐 85 天以内的所有日期。

它需要与访问分析相同的账户 ID 和 API 令牌，以及 `R2` 绑定。Pages 部署没有定时触发器，因此不会归档。

::: warning 个人数据
归档会无限期保留访客的 IP 地址和 User-Agent。请保持 R2 存储桶为私有，并在处理数据删除请求时记得这些文件。
:::

同一任务在某天的各小时归档完成后，还会把每个链接的每日数据写入 D1：

- `analytics_daily`：每个链接每个 UTC 日的访问量、访客数和来源数，算法与链接卡片相同。
- `analytics_daily_breakdown`：每个链接、每个 UTC 日、各维度每个取值的访问量和访客数（来源、国家、地区、城市、时区、语言、操作系统、浏览器、浏览器类型、设备、设备类型、Cloudflare 数据中心）。

分析页面会为超过 88 天的日期读取每日数据（Analytics Engine 可能已删除这些数据）。对于这些日期：

- 计数器、按天的趋势图和详情列表来自按 UTC 日计算的每日数据。访问量是精确值；访客数和来源数是每日数值之和，因此是估算值。同时包含新旧日期的列表是近似值，因为每部分只保留排名靠前的取值。
- 按小时的图表和每周趋势热力图只涵盖最近 3 个月。
- 每日数据尚未写入的日期显示为没有数据，而不是零。一次查看最多读取最近 88 天之前的 366 天，更早的日期同样显示为没有数据。
- 为了不超出免费套餐的 D1 读取额度，这些较早日期的读取在当天读取 2,000,000 行 D1 后停止，页面会提示较早的日期明天才能再次查看。
- 如果完全没有每日数据（Pages，或没有 R2 的 Worker），页面会像以前一样读取 Analytics Engine。
- 按链接或短链码筛选可以使用；其他筛选（仅限 API）会排除这些较早的日期，返回结果中的 `history` 字段会说明。
- 链接卡片、CSV 导出、最近事件、地球视图和 MCP 分析工具仍只读取 Analytics Engine。

R2 归档用于下载和离线分析，仪表盘不会读取它。

日志含义：

- `analytics_export.stopped`：Analytics Engine、网络、R2 或 D1 出错。本次运行停止，5 分钟后重试同一步骤（某个小时，或某天的每日数据）；只要该日期未满 85 天，就不会丢失数据。日志会写明步骤、状态码和错误名称。
- `analytics_export.hour_truncated`：该小时超过 10,000 条记录（例如遭遇请求洪水），只保留前 10,000 条。
- `analytics_export.write_budget`：每日数据今天已写入 50,000 行 D1（约为免费套餐每日写入额度的一半），停止到下一个 UTC 日。归档继续进行。
- `analytics_export.size_limit`（每小时记录一次）：D1 数据库超过 400 MB，或 D1 未返回数据库大小，每日数据停止写入。归档继续进行。
- `analytics_export.step_parked`：某个步骤的返回结果连续 3 次不正确（例如记录数少于统计数、某行无法读取、某页取值过长无法写入，或每日数据后续分页的查询被拒绝，该查询包含已记录的值），该步骤会被跳过；对于小时归档，已收到的数据仍保存在文件中。要在其未满 85 天时重试被跳过的步骤，请运行：

```sh
npx wrangler d1 execute <database> --remote --command "UPDATE analytics_export_steps SET parked_at = NULL, attempts = 0 WHERE parked_at IS NOT NULL"
```

## 导出

可在仪表盘或统计导出 API 下载筛选后的 CSV（短链码、URL、访客、访问量、来源等）。

链接 JSON 导出是另一项功能 — 见[导入/导出](./import-export)。
