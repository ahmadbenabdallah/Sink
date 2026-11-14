---
title: 升级 Sink
description: 通过同步 GitHub Fork 并重新部署来升级 Sink。
---

# 升级 Sink

## 升级前

1. 看一眼上游版本说明
2. 不要删除 Cloudflare 绑定、密钥和环境变量
3. 如果已配置 R2，可先手动[备份](/zh-CN/features/backups)

## 普通升级（当前 D1 部署）

1. 在 GitHub 打开你的 Fork → 点 **Sync fork** 同步最新 `master`。如果自己改过文件，先解决冲突
2. 在 Cloudflare（Workers Builds 或 Pages）重新部署更新后的 `master`
3. 等待部署完成（数据库更新会在部署过程中自动执行）

## 升级很旧的实例（链接只存在 KV 里）

如果旧版本只用 KV 存链接，请先保留该 KV 数据，再按[存储初始化 / 迁移](/zh-CN/storage/kv-to-d1)操作。

## 链接目标必须是网页地址

新建和编辑的链接只接受 `http://` 和 `https://` 目标，包括主 URL、App Store 和 Play Store URL 以及每个地区 URL。仪表盘、API、导入和 MCP 都适用。`javascript:` 或 `data:` 这类目标会在你的短链域名上作为脚本运行。

此前保存的链接继续可用，仍可列出、导出和删除。访问者只会得到普通跳转，不会看到隐藏跳转页或预览页；仪表盘只显示其目标文本，不提供可点击链接。要编辑这类链接，先把目标改成 `http://` 或 `https://` 地址。包含这类链接的导入文件会被拒绝，错误信息会指出是哪一行。

## 升级后快速检查

- 能登录仪表盘
- 打开一次 **Dashboard → Links**（如需会完成存储初始化）
- 创建、打开、编辑、删除一个测试链接
- 若用了访问分析，确认能看到数据
