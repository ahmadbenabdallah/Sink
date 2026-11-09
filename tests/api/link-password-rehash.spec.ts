import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { links } from '../../server/database/schema'
import { rehashPlaintextLinkPasswords } from '../../server/utils/link-password-rehash'
import { LINK_PASSWORD_HASH_PREFIX } from '../../shared/utils/link-password'
import { clearLinkMigrationState, db, deleteStoredLinks, fetch, getD1Link, postJson, runScheduledTasks, setLinkStoreD1Mode } from '../utils'

vi.mock('#shared/utils/link-password', async () => import('../../shared/utils/link-password'))

const createdSlugs: string[] = []
const updatedAt = 1700000000

async function seedPlaintextLink(password: string | null) {
  const slug = `rehash-${crypto.randomUUID()}`
  createdSlugs.push(slug)
  await db.insert(links).values({
    slug,
    id: crypto.randomUUID().slice(0, 10),
    url: `https://example.com/${slug}`,
    normalizedUrl: `https://example.com/${slug}`,
    createdAt: updatedAt,
    updatedAt,
    password,
  })
  return slug
}

afterEach(async () => {
  await deleteStoredLinks(createdSlugs.splice(0))
  await clearLinkMigrationState()
})

describe('plaintext link password rehash', { concurrent: false }, () => {
  it('hashes plaintext D1 passwords on the scheduled run, keeping them verifiable', { timeout: 60_000 }, async () => {
    await setLinkStoreD1Mode()
    const slug = await seedPlaintextLink('legacy-plain-123')
    await env.KV.put(`link:${slug}`, JSON.stringify({ slug, url: `https://example.com/${slug}`, password: 'legacy-plain-123' }))

    await runScheduledTasks()

    // The Worker runs cron hooks via its own waitUntil, which runScheduledTasks cannot await.
    await vi.waitFor(async () => {
      const stored = await getD1Link(slug)
      expect(stored?.password?.startsWith(LINK_PASSWORD_HASH_PREFIX), stored?.password ?? undefined).toBe(true)
      expect(await env.KV.get(`link:${slug}`)).toBeNull()
    }, { timeout: 30_000, interval: 250 })
    expect((await getD1Link(slug))?.updatedAt).toBe(updatedAt)
    expect((await fetch(`/${slug}`, { redirect: 'manual', headers: { 'x-link-password': 'wrong-password' } })).status).toBe(403)
    expect((await fetch(`/${slug}`, { redirect: 'manual', headers: { 'x-link-password': 'legacy-plain-123' } })).status).toBe(301)
  })

  it('hashes a plaintext password and reports the count', async () => {
    await setLinkStoreD1Mode()
    const slug = await seedPlaintextLink('legacy-plain-789')

    expect(await rehashPlaintextLinkPasswords(env)).toBe(1)

    expect((await getD1Link(slug))?.password?.startsWith(LINK_PASSWORD_HASH_PREFIX)).toBe(true)
  })

  it('leaves hashed and password-less links untouched', async () => {
    await setLinkStoreD1Mode()
    const hashedSlug = `rehash-hashed-${crypto.randomUUID()}`
    createdSlugs.push(hashedSlug)
    expect((await postJson('/api/link/create', { url: 'https://example.com/h', slug: hashedSlug, password: 'already-hashed-1' })).status).toBe(201)
    const hashedBefore = (await getD1Link(hashedSlug))?.password
    const openSlug = await seedPlaintextLink(null)

    expect(await rehashPlaintextLinkPasswords(env)).toBe(0)

    expect((await getD1Link(hashedSlug))?.password).toBe(hashedBefore)
    expect((await getD1Link(openSlug))?.password).toBeNull()
  })

  it('does nothing before the KV-to-D1 migration completes', async () => {
    await clearLinkMigrationState()
    const slug = await seedPlaintextLink('legacy-plain-456')

    expect(await rehashPlaintextLinkPasswords(env)).toBe(0)

    expect((await getD1Link(slug))?.password).toBe('legacy-plain-456')
  })
})
