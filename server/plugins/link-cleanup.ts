export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {
    if (isAnalyticsExportRun(event))
      return
    const env = event.env as Cloudflare.Env & Record<string, unknown>
    const retentionDays = env.NUXT_EXPIRED_LINK_RETENTION_DAYS ?? useRuntimeConfig().expiredLinkRetentionDays
    await cleanupExpiredLinks(env, retentionDays)
  })
})
