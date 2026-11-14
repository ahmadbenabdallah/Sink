import type { Link } from '../../shared/schemas/link'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { links } from '../../server/database/schema'
import { createTestConnector, db, deleteStoredLinks, fetch, fetchWithAuth, getD1Link, postJson, putJson, setLinkStoreD1Mode } from '../utils'

// A target that is not a web address runs as script on this origin when the
// cloaking page frames it or the dashboard links to it. New input takes only
// http and https; links stored before that rule stay readable and deletable.
const REFUSED_TARGETS = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'mailto:someone@example.com',
  'ftp://example.com/file',
]

const FIELDS: Record<string, (target: string) => Record<string, unknown>> = {
  url: target => ({ url: target }),
  apple: target => ({ apple: target }),
  google: target => ({ google: target }),
  geo: target => ({ geo: { US: target } }),
}

const createdSlugs: string[] = []

function newSlug(prefix: string) {
  const slug = `${prefix}-${crypto.randomUUID().slice(0, 12)}`
  createdSlugs.push(slug)
  return slug
}

function linkBody(slug: string, extra: Record<string, unknown>) {
  return { url: 'https://example.com/ok', slug, ...extra }
}

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  'Mcp-Protocol-Version': '2025-11-25',
}

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const response = await fetch('/api/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
  })
  const text = await response.text()
  const dataLine = text.split('\n').find(line => line.startsWith('data:'))
  return JSON.parse(dataLine ? dataLine.slice(5) : text) as { result?: { isError?: boolean }, error?: unknown }
}

// Every refusal names the rule, so a refusal for another reason does not pass.
const RULE = 'http:// or https://'

function refused(payload: { result?: { isError?: boolean }, error?: unknown }) {
  return (payload.error !== undefined || payload.result?.isError === true) && JSON.stringify(payload).includes(RULE)
}

async function expectRefused(response: Response) {
  expect(response.status).toBe(400)
  expect(JSON.stringify(await response.json())).toContain(RULE)
}

/** Writes a link straight to D1, as one saved before the scheme rule would be. */
async function insertStoredLink(link: Partial<Link> & { slug: string, url: string }) {
  const now = Math.floor(Date.now() / 1000)
  // Ahead of every other test link, so it is on the first page of a newest-first list.
  const createdAt = now + 86_400
  await db.insert(links).values({
    id: crypto.randomUUID().slice(0, 10),
    createdAt,
    updatedAt: createdAt,
    normalizedUrl: link.url.split('?')[0]!,
    ...link,
  })
}

beforeEach(async () => {
  await setLinkStoreD1Mode()
})

afterAll(async () => {
  await deleteStoredLinks(createdSlugs)
})

describe('new link targets must be web addresses', () => {
  for (const [field, build] of Object.entries(FIELDS)) {
    for (const target of REFUSED_TARGETS) {
      it(`refuses ${target} as ${field} on create, upsert and import`, async () => {
        const slug = newSlug('scheme')
        await expectRefused(await postJson('/api/link/create', linkBody(slug, build(target))))
        await expectRefused(await postJson('/api/link/upsert', linkBody(slug, build(target))))
        await expectRefused(await postJson('/api/link/import', { version: '1.0', links: [linkBody(slug, build(target))] }))
        expect(await getD1Link(slug)).toBeNull()
      })
    }

    it(`refuses a non-web ${field} on edit and keeps the stored link`, async () => {
      const slug = newSlug('scheme-edit')
      expect((await postJson('/api/link/create', linkBody(slug, {}))).status).toBe(201)

      for (const target of REFUSED_TARGETS)
        await expectRefused(await putJson('/api/link/edit', linkBody(slug, build(target))))

      const stored = await getD1Link(slug)
      expect(stored).toMatchObject({ url: 'https://example.com/ok', apple: null, google: null, geo: null })
    })
  }

  it('still takes http and https in every field, on every write path', async () => {
    const targets = {
      url: 'HTTP://example.com/upper',
      apple: 'https://apps.apple.com/app/id1',
      google: 'https://play.google.com/store/apps/details?id=a',
      geo: { US: 'http://example.com/us' },
    }
    const slug = newSlug('scheme-ok')
    expect((await postJson('/api/link/create', linkBody(slug, targets))).status).toBe(201)
    expect((await putJson('/api/link/edit', linkBody(slug, targets))).status).toBe(201)
    expect((await postJson('/api/link/upsert', linkBody(newSlug('scheme-ok'), targets))).status).toBe(201)
    const imported = await postJson('/api/link/import', { version: '1.0', links: [linkBody(newSlug('scheme-ok'), targets)] })
    expect(await imported.json()).toMatchObject({ success: 1, failed: 0 })

    const { token } = await createTestConnector('full')
    expect(refused(await callTool(token, 'create_link', linkBody(newSlug('scheme-ok'), targets)))).toBe(false)
    expect(refused(await callTool(token, 'upsert_link', linkBody(newSlug('scheme-ok'), targets)))).toBe(false)
    expect(refused(await callTool(token, 'update_link', { slug, ...targets }))).toBe(false)
  })

  it('refuses non-web targets in the MCP create, upsert and update tools', async () => {
    const { token } = await createTestConnector('full')
    const existing = newSlug('scheme-mcp')
    expect(refused(await callTool(token, 'create_link', { url: 'https://example.com/ok', slug: existing }))).toBe(false)

    for (const [field, build] of Object.entries(FIELDS)) {
      for (const target of ['javascript:alert(1)', 'DATA:text/html,x']) {
        const slug = newSlug('scheme-mcp')
        expect(refused(await callTool(token, 'create_link', linkBody(slug, build(target)))), `create ${field} ${target}`).toBe(true)
        expect(refused(await callTool(token, 'upsert_link', linkBody(slug, build(target)))), `upsert ${field} ${target}`).toBe(true)
        expect(await getD1Link(slug)).toBeNull()
        expect(refused(await callTool(token, 'update_link', { slug: existing, ...build(target) })), `update ${field} ${target}`).toBe(true)
      }
    }

    expect(await getD1Link(existing)).toMatchObject({ url: 'https://example.com/ok', apple: null, google: null, geo: null })
  })
})

describe('a link stored with a non-web target', () => {
  it('is still listed, exported, read and deletable', async () => {
    const slug = newSlug('scheme-stored')
    await insertStoredLink({ slug, url: 'javascript:alert(1)' })

    const query = await fetchWithAuth(`/api/link/query?slug=${slug}`)
    expect(query.status).toBe(200)
    expect(await query.json()).toMatchObject({ slug, url: 'javascript:alert(1)' })

    const list = await (await fetchWithAuth('/api/link/list?limit=20')).json() as { links: Link[] }
    expect(list.links.map(link => link.slug)).toContain(slug)

    const exported = await (await fetchWithAuth('/api/link/export')).json() as { links: Link[] }
    expect(exported.links.map(link => link.slug)).toContain(slug)

    expect((await postJson('/api/link/delete', { slug })).status).toBe(204)
    expect(await getD1Link(slug)).toBeNull()
  })

  // As with a full edit, a patch must leave the link with web targets only.
  it('cannot be patched through MCP until its target is a web address', async () => {
    const { token } = await createTestConnector('full')
    for (const legacy of [{ url: 'javascript:alert(1)' }, { url: 'https://example.com/ok', geo: { US: 'data:text/html,x' } }]) {
      const slug = newSlug('scheme-patch')
      await insertStoredLink({ slug, ...legacy })

      expect(refused(await callTool(token, 'update_link', { slug, comment: 'changed' }))).toBe(true)
      expect((await getD1Link(slug))?.comment).toBeNull()
    }

    const slug = newSlug('scheme-patch')
    await insertStoredLink({ slug, url: 'javascript:alert(1)' })
    expect(refused(await callTool(token, 'update_link', { slug, url: 'https://example.com/fixed' }))).toBe(false)
    expect(await getD1Link(slug)).toMatchObject({ url: 'https://example.com/fixed' })
  })

  it('gets a plain redirect, never the cloaking page', async () => {
    const slug = newSlug('scheme-cloak')
    await insertStoredLink({ slug, url: 'javascript:alert(1)', cloaking: true })

    const response = await fetch(`/${slug}`, { redirect: 'manual' })
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('javascript:alert(1)')
    // No body: a meta refresh to the target would be one more place it could run.
    expect(await response.text()).toBe('')
  })

  // The browser drops the NUL and reads the rest as a path on this origin, so
  // the target must not count as a web address just because URL parsing skips it.
  it('gets no cloaking page when a control character hides in front of https', async () => {
    const slug = newSlug('scheme-nul')
    await insertStoredLink({ slug, url: '\u0000https://example.com/../x', cloaking: true })

    const response = await fetch(`/${slug}`, { redirect: 'manual' })
    expect(response.status).not.toBe(200)
    expect(await response.text()).not.toContain('<iframe')
  })

  it('gets a bodiless redirect when its device target is not a web address', async () => {
    const slug = newSlug('scheme-device')
    await insertStoredLink({ slug, url: 'https://example.com/ok', apple: 'javascript:alert(1)' })

    const response = await fetch(`/${slug}`, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } })
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('javascript:alert(1)')
    expect(await response.text()).toBe('')
  })

  it('gets a plain redirect when only its geo target is not a web address', async () => {
    const slug = newSlug('scheme-geo')
    await insertStoredLink({ slug, url: 'https://example.com/ok', cloaking: true, geo: { US: 'javascript:alert(1)' } })

    const response = await fetch(`/${slug}`, { redirect: 'manual', cf: { country: 'US' } } as RequestInit)
    expect(response.status).toBe(301)
    expect(await response.text()).not.toContain('<iframe')

    // Visitors elsewhere still get the cloaking page for the web target.
    const elsewhere = await fetch(`/${slug}`, { redirect: 'manual', cf: { country: 'FR' } } as RequestInit)
    expect(elsewhere.status).toBe(200)
    expect(await elsewhere.text()).toContain('<iframe src="https://example.com/ok"')
  })

  it('gets a plain redirect for social bots, never the preview page', async () => {
    const slug = newSlug('scheme-og')
    await insertStoredLink({ slug, url: 'javascript:alert(1)', title: 'Preview title' })

    const response = await fetch(`/${slug}`, { redirect: 'manual', headers: { 'User-Agent': 'Twitterbot/1.0' } })
    expect(response.status).toBe(301)
    expect(await response.text()).toBe('')
  })
})
