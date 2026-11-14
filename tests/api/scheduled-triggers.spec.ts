import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { links } from '../../server/database/schema'
import { LINK_PASSWORD_HASH_PREFIX } from '../../shared/utils/link-password'
import { clearLinkMigrationState, db, deleteStoredLinks, getD1Link, runScheduledTasks, setLinkStoreD1Mode } from '../utils'

// The analytics export runs every 5 minutes. The jobs that already run on the
// daily trigger (link backup, expired-link cleanup, password re-hashing) must
// ignore that trigger, or the link backup would run 288 times a day. They keep
// running on any other trigger, so an owner who changed the daily schedule in
// wrangler.jsonc keeps their backups.
const EXPORT_TRIGGER = '*/5 * * * *'

const bindings = env as Cloudflare.Env & Record<string, unknown>
const createdSlugs: string[] = []
let originalRetention: unknown

async function seedLinks() {
  const now = Math.floor(Date.now() / 1000)
  const expired = `trigger-expired-${crypto.randomUUID()}`
  const plaintext = `trigger-plain-${crypto.randomUUID()}`
  createdSlugs.push(expired, plaintext)
  await db.insert(links).values([
    { slug: expired, id: crypto.randomUUID().slice(0, 10), url: 'https://example.com/expired', normalizedUrl: 'https://example.com/expired', createdAt: now - 864000, updatedAt: now - 864000, expiration: now - 864000, effectiveExpiresAt: now - 864000 },
    { slug: plaintext, id: crypto.randomUUID().slice(0, 10), url: 'https://example.com/plain', normalizedUrl: 'https://example.com/plain', createdAt: now, updatedAt: now, password: 'plain-text-pass' },
  ])
  return { expired, plaintext }
}

async function backupKeys() {
  return new Set((await env.R2.list({ prefix: 'backups/' })).objects.map(object => object.key))
}

async function deleteNewBackups(before: Set<string>) {
  for (const key of await backupKeys()) {
    if (!before.has(key))
      await env.R2.delete(key)
  }
}

afterEach(async () => {
  if (originalRetention === undefined)
    delete bindings.NUXT_EXPIRED_LINK_RETENTION_DAYS
  else
    bindings.NUXT_EXPIRED_LINK_RETENTION_DAYS = originalRetention
  await deleteStoredLinks(createdSlugs.splice(0))
  await clearLinkMigrationState()
})

describe('scheduled triggers', { concurrent: false }, () => {
  it('runs none of the daily jobs on the 5-minute export trigger', async () => {
    await setLinkStoreD1Mode()
    originalRetention = bindings.NUXT_EXPIRED_LINK_RETENTION_DAYS
    bindings.NUXT_EXPIRED_LINK_RETENTION_DAYS = '0'
    const { expired, plaintext } = await seedLinks()
    const before = await backupKeys()

    try {
      await runScheduledTasks(EXPORT_TRIGGER)
      // The hooks run inside the Worker's own waitUntil, which this helper cannot await.
      // The daily chain takes about 1.5 s locally, so wait well past that before
      // checking that nothing happened.
      await new Promise(resolve => setTimeout(resolve, 4000))

      expect(await getD1Link(expired)).toEqual(expect.objectContaining({ slug: expired }))
      expect((await getD1Link(plaintext))?.password).toBe('plain-text-pass')
      expect(await backupKeys()).toEqual(before)
    }
    finally {
      await deleteNewBackups(before)
    }
  })

  it('still runs the daily jobs on a daily trigger the owner chose', { timeout: 60_000 }, async () => {
    await setLinkStoreD1Mode()
    originalRetention = bindings.NUXT_EXPIRED_LINK_RETENTION_DAYS
    bindings.NUXT_EXPIRED_LINK_RETENTION_DAYS = '0'
    const { expired, plaintext } = await seedLinks()
    const before = await backupKeys()

    try {
      await runScheduledTasks('0 3 * * *')

      await vi.waitFor(async () => {
        expect(await getD1Link(expired)).toBeNull()
        expect((await getD1Link(plaintext))?.password?.startsWith(LINK_PASSWORD_HASH_PREFIX)).toBe(true)
        expect((await backupKeys()).size).toBeGreaterThan(before.size)
      }, { timeout: 30_000, interval: 250 })
    }
    finally {
      await deleteNewBackups(before)
    }
  })
})
