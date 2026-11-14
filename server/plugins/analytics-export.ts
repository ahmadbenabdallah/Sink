/// <reference path="../../worker-configuration.d.ts" />

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {
    if (!isAnalyticsExportRun(event))
      return

    // Read the bindings at run time first: the runtime config seen without a
    // request event is fixed when the Worker starts.
    const env = event.env as Cloudflare.Env & Record<string, unknown>
    const config = useRuntimeConfig()
    await runAnalyticsExport(env, {
      accountId: String(env.NUXT_CF_ACCOUNT_ID ?? config.cfAccountId ?? ''),
      apiToken: String(env.NUXT_CF_API_TOKEN ?? config.cfApiToken ?? ''),
      dataset: String(env.NUXT_DATASET ?? config.dataset ?? 'sink'),
      now: event.controller.scheduledTime,
    })
  })
})
