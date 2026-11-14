export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {
    if (isAnalyticsExportRun(event))
      return
    await rehashPlaintextLinkPasswords(event.env as Cloudflare.Env)
  })
})
