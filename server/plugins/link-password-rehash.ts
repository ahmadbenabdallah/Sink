export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {
    await rehashPlaintextLinkPasswords(event.env as Cloudflare.Env)
  })
})
