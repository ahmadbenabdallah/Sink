import type { H3Event } from 'h3'
import type { Link } from '../../shared/schemas/link'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { links, linkTags, tags } from '../../server/database/schema'
import { d1UpdateLink } from '../../server/services/link-store/d1'
import { db, deleteStoredLinks } from '../utils'

const event = { context: { cloudflare: { env } } } as unknown as H3Event
const createdSlugs: string[] = []
const createdTags: string[] = []

async function seedLink(): Promise<Link> {
  const slug = `update-tags-${crypto.randomUUID()}`
  createdSlugs.push(slug)
  const link: Link = { id: crypto.randomUUID().slice(0, 10), slug, url: `https://example.com/${slug}`, createdAt: 1700000000, updatedAt: 1700000000, tags: [] }
  await db.insert(links).values({ slug, id: link.id, url: link.url, normalizedUrl: link.url, createdAt: link.createdAt, updatedAt: link.updatedAt })
  return link
}

function uniqueTag(): string {
  const tag = `tag-${crypto.randomUUID().slice(0, 12)}`
  createdTags.push(tag)
  return tag
}

async function tagExists(name: string): Promise<boolean> {
  return (await db.select().from(tags).where(eq(tags.name, name))).length > 0
}

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { previewMode: '' } }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await deleteStoredLinks(createdSlugs.splice(0))
  for (const tag of createdTags.splice(0))
    await db.delete(tags).where(eq(tags.name, tag))
})

describe('d1UpdateLink tags', { concurrent: false }, () => {
  it('creates no tag rows when the expected version no longer matches', async () => {
    const link = await seedLink()
    const tag = uniqueTag()

    const result = await d1UpdateLink(event, { ...link, tags: [tag] }, { id: link.id, updatedAt: link.updatedAt + 1 })

    expect(result.updated).toBe(false)
    expect(await tagExists(tag)).toBe(false)
  })

  it('creates and links the tag when the expected version matches', async () => {
    const link = await seedLink()
    const tag = uniqueTag()

    const result = await d1UpdateLink(event, { ...link, tags: [tag] }, { id: link.id, updatedAt: link.updatedAt })

    expect(result.updated).toBe(true)
    expect(await tagExists(tag)).toBe(true)
    expect(await db.select().from(linkTags).where(eq(linkTags.linkSlug, link.slug))).toEqual([{ linkSlug: link.slug, tagName: tag }])
  })

  it('creates and links the tag for an unconditional update', async () => {
    const link = await seedLink()
    const tag = uniqueTag()

    const result = await d1UpdateLink(event, { ...link, tags: [tag] })

    expect(result.updated).toBe(true)
    expect(await tagExists(tag)).toBe(true)
  })
})
