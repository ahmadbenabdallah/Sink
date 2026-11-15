import { env } from 'cloudflare:workers'
import { eq, inArray } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deletedLinkIds, links } from '../../server/database/schema'
import { cleanupExpiredLinks } from '../../server/utils/link-cleanup'
import { clearLinkMigrationState, db, deleteStoredLinks, fetchWithAuth, postJson, setLinkStoreD1Mode } from '../utils'

// The ids of deleted links are recorded so their traffic can be left out of
// analytics (server/utils/cloudflare.ts:useWAE).

let slugs: string[] = []
let ids: string[] = []

async function createLink(slug: string) {
  slugs.push(slug)
  const response = await postJson('/api/link/create', { url: `https://example.com/${slug}`, slug })
  expect(response.status).toBe(201)
  const { link } = await response.json() as { link: { id: string, slug: string } }
  ids.push(link.id)
  return link
}

async function deletedRow(id: string) {
  const [row] = await db.select().from(deletedLinkIds).where(eq(deletedLinkIds.id, id))
  return row
}

beforeEach(async () => {
  await setLinkStoreD1Mode()
})

afterEach(async () => {
  await deleteStoredLinks(slugs)
  if (ids.length)
    await db.delete(deletedLinkIds).where(inArray(deletedLinkIds.id, ids))
  slugs = []
  ids = []
  await clearLinkMigrationState()
})

describe('deleted link ids', { concurrent: false }, () => {
  it('records the id of a link the owner deletes', async () => {
    const link = await createLink(`deleted-${crypto.randomUUID().slice(0, 8)}`)
    const before = Math.floor(Date.now() / 1000)

    expect((await postJson('/api/link/delete', { slug: link.slug })).status).toBe(204)

    expect(await deletedRow(link.id)).toEqual({ id: link.id, deletedAt: expect.any(Number) })
    expect((await deletedRow(link.id))!.deletedAt).toBeGreaterThanOrEqual(before)
  })

  it('gives a new link that reuses the slug a new id, which is not on the list', async () => {
    const slug = `reused-${crypto.randomUUID().slice(0, 8)}`
    const old = await createLink(slug)
    await postJson('/api/link/delete', { slug })

    const reused = await createLink(slug)

    expect(reused.id).not.toBe(old.id)
    expect(await deletedRow(old.id)).toBeDefined()
    expect(await deletedRow(reused.id)).toBeUndefined()
  })

  it('takes the id off the list when the link is restored by import', async () => {
    const link = await createLink(`restored-${crypto.randomUUID().slice(0, 8)}`)
    const exported = await (await fetchWithAuth(`/api/link/query?slug=${link.slug}`)).json() as Record<string, unknown>
    await postJson('/api/link/delete', { slug: link.slug })
    expect(await deletedRow(link.id)).toBeDefined()

    const imported = await postJson('/api/link/import', { version: '1.0', links: [exported] })

    expect(await imported.json()).toMatchObject({ success: 1 })
    expect(await deletedRow(link.id)).toBeUndefined()
  })

  it('keeps the id on the list when an import loses to an active link with the same slug', async () => {
    const deleted = await createLink(`gone-${crypto.randomUUID().slice(0, 8)}`)
    await postJson('/api/link/delete', { slug: deleted.slug })
    const active = await createLink(`active-${crypto.randomUUID().slice(0, 8)}`)

    const imported = await postJson('/api/link/import', { version: '1.0', links: [{ id: deleted.id, slug: active.slug, url: 'https://example.com/other' }] })

    expect(await imported.json()).toMatchObject({ success: 0 })
    expect(await deletedRow(deleted.id)).toBeDefined()
  })

  it('does not record links removed by the expired-link cleanup', async () => {
    const now = Math.floor(Date.now() / 1000)
    const slug = `expired-${crypto.randomUUID().slice(0, 8)}`
    const id = crypto.randomUUID()
    slugs.push(slug)
    ids.push(id)
    await db.insert(links).values({ slug, id, url: 'https://example.com', normalizedUrl: 'https://example.com', createdAt: now - 86_400 * 10, updatedAt: now - 86_400 * 10, expiration: now - 86_400 * 5, effectiveExpiresAt: now - 86_400 * 5 })

    expect(await cleanupExpiredLinks(env, '0')).toBeGreaterThanOrEqual(1)

    expect(await deletedRow(id)).toBeUndefined()
  })
})
