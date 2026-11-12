import type { Link } from '../shared/schemas/link'
import type { McpLevel } from '../shared/types/auth'
import { env, exports } from 'cloudflare:workers'
import { eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { expect } from 'vitest'
import { linkMigrationRuns, links, linkTombstones } from '../server/database/schema'
import { createToken } from '../server/services/mcp/tokens'
import { LINK_PASSWORD_HASH_PREFIX, LINK_PASSWORD_MASK_PREFIX } from '../shared/utils/link-password'

export const db = drizzle(env.DB)

/**
 * Creates a connector token straight in the store and returns its value. The
 * value is generated at run time, so no token text is ever committed.
 */
export async function createTestConnector(level: McpLevel) {
  const { connector, token } = await createToken(db, { name: `Test ${level} ${crypto.randomUUID().slice(0, 8)}`, level })
  return { id: connector.id, token }
}

export async function runScheduledTasks() {
  const pending: Promise<unknown>[] = []
  const context = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise)
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext
  await exports.default.scheduled!({
    scheduledTime: Date.now(),
    cron: '0 0 * * *',
    noRetry() {},
  }, env, context)
  await Promise.all(pending)
}

/**
 * `/api/` requests are rate-limited per client address, and requests without one
 * share a single bucket. The whole suite runs against one Worker, so each API
 * request gets an address of its own unless the test sets one. Other paths are
 * left alone: some tests check what happens when no address is sent.
 */
function withClientAddress(path: string, headers: HeadersInit | undefined): HeadersInit | undefined {
  if (!path.startsWith('/api/'))
    return headers
  const octet = () => Math.floor(Math.random() * 256)
  // 198.18.0.0/15 is reserved for benchmarking, so it cannot collide with a
  // documentation address a test picks on purpose.
  return { 'cf-connecting-ip': `198.18.${octet()}.${octet()}`, ...headers }
}

export function fetchWithAuth(path: string, options?: RequestInit): Promise<Response> {
  const request = new Request(`http://localhost${path}`, {
    ...options,
    headers: {
      ...withClientAddress(path, options?.headers),
      Authorization: `Bearer ${import.meta.env.NUXT_SITE_TOKEN}`,
    },
  })
  return exports.default.fetch(request)
}

export function fetch(path: string, options?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`http://localhost${path}`, { ...options, headers: withClientAddress(path, options?.headers) }))
}

export function postJson(path: string, body: unknown, withAuth = true): Promise<Response> {
  const fn = withAuth ? fetchWithAuth : fetch
  return fn(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

export function putJson(path: string, body: unknown, withAuth = true): Promise<Response> {
  const fn = withAuth ? fetchWithAuth : fetch
  return fn(path, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function getStoredLink(slug: string) {
  return await env.KV.get<Link>(`link:${slug}`, { type: 'json' })
}

export async function getD1Link(slug: string) {
  const [link] = await db.select().from(links).where(eq(links.slug, slug)).limit(1)
  return link ?? null
}

export async function deleteStoredLink(slug: string) {
  await Promise.all([
    env.KV.delete(`link:${slug}`),
    db.delete(links).where(eq(links.slug, slug)),
    db.delete(linkTombstones).where(eq(linkTombstones.slug, slug)),
  ])
}

export async function deleteStoredLinks(slugs: string[]) {
  // Chunked deletes: one statement per table per 50 slugs instead of two per slug,
  // so cleanup of 100+ seeded links stays well inside the hook timeout.
  const chunks: string[][] = []
  for (let index = 0; index < slugs.length; index += 50)
    chunks.push(slugs.slice(index, index + 50))
  await Promise.all([
    ...slugs.map(slug => env.KV.delete(`link:${slug}`)),
    ...chunks.flatMap(chunk => [
      db.delete(links).where(inArray(links.slug, chunk)),
      db.delete(linkTombstones).where(inArray(linkTombstones.slug, chunk)),
    ]),
  ])
}

export async function clearLinkMigrationState() {
  await db.delete(linkMigrationRuns)
}

export async function setLinkStoreD1Mode() {
  await clearLinkMigrationState()
  const now = Math.floor(Date.now() / 1000)
  await db.insert(linkMigrationRuns).values({
    id: `test-completed-${crypto.randomUUID()}`,
    expectedCursor: null,
    scanned: 0,
    inserted: 0,
    skipped: 0,
    expired: 0,
    force: false,
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  })
}

export function expectMaskedPassword(password: string | undefined, plainText: string) {
  expect(password).toBeDefined()
  expect(password?.startsWith(LINK_PASSWORD_MASK_PREFIX), password).toBe(true)
  expect(password).toContain(plainText.slice(-3))
  expect(password).not.toBe(plainText)
  expect(password?.startsWith(LINK_PASSWORD_HASH_PREFIX)).toBe(false)
}

export async function expectStoredHashedPassword(slug: string, plainText: string) {
  const storedLink = await getStoredLink(slug)
  expect(storedLink?.password?.startsWith(LINK_PASSWORD_HASH_PREFIX), storedLink?.password).toBe(true)
  expect(storedLink?.password).not.toBe(plainText)
}

// 1x1 transparent PNG for testing
export const TEST_PNG_BYTES = new Uint8Array([
  0x89,
  0x50,
  0x4E,
  0x47,
  0x0D,
  0x0A,
  0x1A,
  0x0A,
  0x00,
  0x00,
  0x00,
  0x0D,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1F,
  0x15,
  0xC4,
  0x89,
  0x00,
  0x00,
  0x00,
  0x0A,
  0x49,
  0x44,
  0x41,
  0x54,
  0x78,
  0x9C,
  0x63,
  0x00,
  0x01,
  0x00,
  0x00,
  0x05,
  0x00,
  0x01,
  0x0D,
  0x0A,
  0x2D,
  0xB4,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4E,
  0x44,
  0xAE,
  0x42,
  0x60,
  0x82,
])
