import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { links, linkTags, tags } from '../../server/database/schema'
import { clearLinkMigrationState, createTestConnector, db, deleteStoredLinks, fetch, fetchWithAuth, setLinkStoreD1Mode } from '../utils'

// The traffic sorts rank D1 links by their Analytics Engine counts. Analytics
// Engine is stubbed through `fetch`; the links are real D1 rows.

const run = crypto.randomUUID().slice(0, 8)
const TAG = `traffic-${run}`
const now = Math.floor(Date.now() / 1000)
const slug = (name: string) => `traffic-${name}-${run}`
const LINKS = [
  { name: 'a', createdAt: 100, visits: 5, visitors: 1, referers: 2 },
  { name: 'b', createdAt: 200, visits: 9, visitors: 3, referers: 1 },
  { name: 'c', createdAt: 300, visits: 5, visitors: 4, referers: 0 },
  { name: 'd', createdAt: 400 },
  { name: 'e', createdAt: 500 },
]
const EXPIRED = { name: 'old', createdAt: 50, visits: 50, visitors: 5, referers: 1 }
const UNTAGGED = { name: 'free', createdAt: 600, visits: 70, visitors: 7, referers: 1 }
const all = [...LINKS, EXPIRED, UNTAGGED]

let rows: Record<string, unknown>[]
let analyticsSql: string[]
const realFetch = globalThis.fetch

function analyticsRows() {
  const withTraffic = all.filter(link => 'visits' in link) as { name: string, visits: number, visitors: number, referers: number }[]
  return [
    ...withTraffic.map(link => ({ id: `id-${link.name}-${run}`, visits: String(link.visits), visitors: link.visitors, referers: link.referers })),
    // A link deleted from D1 that Analytics Engine still has traffic for.
    { id: `id-gone-${run}`, visits: '999', visitors: 99, referers: 9 },
  ]
}

async function getTraffic(query: string) {
  return await fetchWithAuth(`/api/link/traffic?${query}`)
}

async function errorCode(response: Response) {
  return ((await response.json()) as { data?: { code?: string } }).data?.code
}

beforeAll(async () => {
  await setLinkStoreD1Mode()
  await db.insert(tags).values({ name: TAG }).onConflictDoNothing()
  for (const link of all) {
    const expired = link === EXPIRED
    await db.insert(links).values({
      slug: slug(link.name),
      id: `id-${link.name}-${run}`,
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      createdAt: link.createdAt,
      updatedAt: link.createdAt,
      expiration: expired ? now - 3600 : null,
      effectiveExpiresAt: expired ? now - 3600 : null,
      password: link.name === 'b' ? 'sink-pwd:v1:stored-hash' : null,
    })
    if (link !== UNTAGGED)
      await db.insert(linkTags).values({ linkSlug: slug(link.name), tagName: TAG })
  }
})

beforeEach(() => {
  rows = analyticsRows()
  analyticsSql = []
  env.NUXT_CF_ACCOUNT_ID = 'traffic-account'
  env.NUXT_CF_API_TOKEN = 'traffic-token'
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith('https://api.cloudflare.com/'))
      return realFetch(input, init)
    analyticsSql.push(String(init?.body))
    return Response.json({ data: rows, rows: rows.length })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  env.NUXT_CF_ACCOUNT_ID = ''
  env.NUXT_CF_API_TOKEN = ''
})

afterAll(async () => {
  await deleteStoredLinks(all.map(link => slug(link.name)))
  await db.delete(tags).where(eq(tags.name, TAG))
  await clearLinkMigrationState()
})

describe('/api/link/traffic', { concurrent: false }, () => {
  it('ranks the tagged active links by visits, with the counts it ranked by and zero-traffic links last', async () => {
    const response = await getTraffic(`sort=visits&tag=${TAG}`)

    expect(response.status).toBe(200)
    const body = await response.json() as { links: { slug: string, id: string, password?: string }[], counters: Record<string, unknown>, list_complete: boolean }
    expect(body.links.map(link => link.slug)).toEqual(['b', 'c', 'a', 'e', 'd'].map(slug))
    expect(body.counters[`id-b-${run}`]).toEqual({ visits: 9, visitors: 3, referers: 1 })
    expect(body.counters[`id-d-${run}`]).toEqual({ visits: 0, visitors: 0, referers: 0 })
    expect(body.list_complete).toBe(true)
    // Never a deleted link, and the password is masked as in the list.
    expect(JSON.stringify(body)).not.toContain(`id-gone-${run}`)
    expect(body.links.find(link => link.slug === slug('b'))?.password).not.toBe('sink-pwd:v1:stored-hash')
    // One query: the card formulas grouped by link, with the row cap.
    expect(analyticsSql).toHaveLength(1)
    expect(analyticsSql[0]).toContain('group by index1')
    expect(analyticsSql[0]).toContain('limit 10000')
  })

  it('applies the expired tab', async () => {
    const body = await (await getTraffic(`sort=visits&tag=${TAG}&status=expired`)).json() as { links: { slug: string }[] }
    expect(body.links.map(link => link.slug)).toEqual([slug('old')])
  })

  it('sorts by visitors and by referers', async () => {
    const byVisitors = await (await getTraffic(`sort=visitors&tag=${TAG}`)).json() as { links: { slug: string }[] }
    expect(byVisitors.links.slice(0, 3).map(link => link.slug)).toEqual(['c', 'b', 'a'].map(slug))
    const byReferers = await (await getTraffic(`sort=referers&tag=${TAG}`)).json() as { links: { slug: string }[] }
    expect(byReferers.links.slice(0, 2).map(link => link.slug)).toEqual(['a', 'b'].map(slug))
  })

  it('walks every page once, and refuses a cursor made for another sort', async () => {
    const seen: string[] = []
    let cursor = ''
    let complete = false
    while (!complete) {
      const body = await (await getTraffic(`sort=visits&tag=${TAG}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json() as { links: { slug: string }[], cursor?: string, list_complete: boolean }
      seen.push(...body.links.map(link => link.slug))
      complete = body.list_complete
      if (!complete) {
        expect(body.cursor).toEqual(expect.any(String))
        cursor = body.cursor!
      }
    }
    expect(seen).toEqual(['b', 'c', 'a', 'e', 'd'].map(slug))

    const first = await (await getTraffic(`sort=visits&tag=${TAG}&limit=2`)).json() as { cursor: string }
    const mismatched = await getTraffic(`sort=visitors&tag=${TAG}&limit=2&cursor=${encodeURIComponent(first.cursor)}`)
    expect(mismatched.status).toBe(400)
    expect(await errorCode(mismatched)).toBe('invalid_cursor')
  })

  it('answers 503 analytics_unavailable without calling Analytics Engine when it is not configured', async () => {
    env.NUXT_CF_API_TOKEN = ''

    const response = await getTraffic(`sort=visits&tag=${TAG}`)

    expect(response.status).toBe(503)
    expect(await errorCode(response)).toBe('analytics_unavailable')
    expect(analyticsSql).toHaveLength(0)
  })

  it('answers 503 rather than a partial ranking when Analytics Engine fails or reaches the row cap', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      return url.startsWith('https://api.cloudflare.com/') ? new Response('error', { status: 500 }) : realFetch(input, init)
    })
    const failed = await getTraffic(`sort=visits&tag=${TAG}`)
    expect(failed.status).toBe(503)
    expect(await errorCode(failed)).toBe('analytics_unavailable')

    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!url.startsWith('https://api.cloudflare.com/'))
        return realFetch(input, init)
      return Response.json({ data: Array.from({ length: 10_000 }, (_, i) => ({ id: `cap-${i}`, visits: 1, visitors: 1, referers: 0 })) })
    })
    const capped = await getTraffic(`sort=visits&tag=${TAG}`)
    expect(capped.status).toBe(503)
    expect(warns.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({ event: 'link_traffic.truncated' }))
  })

  it('refuses a request without credentials and a connector token', async () => {
    expect((await fetch(`/api/link/traffic?sort=visits`)).status).toBe(401)
    const { token } = await createTestConnector('full')
    expect((await fetch(`/api/link/traffic?sort=visits`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)
  })

  it('pages a tag outside Latin-1, in the traffic sorts and in the list', async () => {
    const tag = `推广-${run}`
    const slugs = ['x1', 'x2', 'x3'].map(slug)
    await db.insert(tags).values({ name: tag })
    for (const [index, linkSlug] of slugs.entries()) {
      await db.insert(links).values({ slug: linkSlug, id: `id-${linkSlug}`, url: 'https://example.com', normalizedUrl: 'https://example.com', createdAt: 700 + index, updatedAt: 700 + index })
      await db.insert(linkTags).values({ linkSlug, tagName: tag })
    }
    try {
      const traffic = await (await getTraffic(`sort=visits&tag=${encodeURIComponent(tag)}&limit=2`)).json() as { cursor: string }
      const next = await getTraffic(`sort=visits&tag=${encodeURIComponent(tag)}&limit=2&cursor=${encodeURIComponent(traffic.cursor)}`)
      expect(next.status).toBe(200)
      expect(((await next.json()) as { links: unknown[] }).links).toHaveLength(1)

      const list = await (await fetchWithAuth(`/api/link/list?tag=${encodeURIComponent(tag)}&limit=2`)).json() as { cursor: string }
      const nextList = await fetchWithAuth(`/api/link/list?tag=${encodeURIComponent(tag)}&limit=2&cursor=${encodeURIComponent(list.cursor)}`)
      expect(nextList.status).toBe(200)
      expect(((await nextList.json()) as { links: unknown[] }).links).toHaveLength(1)
    }
    finally {
      await deleteStoredLinks(slugs)
      await db.delete(tags).where(eq(tags.name, tag))
    }
  })

  it('refuses a sort that is not a traffic sort', async () => {
    expect((await getTraffic('sort=newest')).status).toBe(400)
  })
})
