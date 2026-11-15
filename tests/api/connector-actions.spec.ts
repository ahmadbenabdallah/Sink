import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpTokens, mcpUsage } from '../../server/database/schema'
import { createTestConnector, db, fetch, fetchWithAuth, postJson } from '../utils'

interface ConnectorView {
  id: string
  name: string
  hint: string
  level: string
  createdAt: number
  revokedAt: number | null
  rotatedAt: number | null
  lastUsedAt: number | null
  calls7d: number | null
}

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  'Mcp-Protocol-Version': '2025-11-25',
}

function uniqueName(label: string) {
  return `${label} ${crypto.randomUUID().slice(0, 8)}`
}

async function createConnector(label: string, level = 'read') {
  const response = await postJson('/api/connector/create', { name: uniqueName(label), level })
  expect(response.status).toBe(201)
  return await response.json() as { connector: ConnectorView, token: string }
}

async function listed(id: string) {
  const { connectors } = await (await fetchWithAuth('/api/connector/list')).json() as { connectors: ConnectorView[] }
  return connectors.find(connector => connector.id === id)
}

function listToolsWith(token: string) {
  return fetch('/api/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
  })
}

async function errorCode(response: Response) {
  return ((await response.json()) as { data?: { code?: string } }).data?.code
}

async function withPreviewMode(run: () => Promise<void>) {
  const previous = env.NUXT_PUBLIC_PREVIEW_MODE
  env.NUXT_PUBLIC_PREVIEW_MODE = 'true'
  try {
    await run()
  }
  finally {
    env.NUXT_PUBLIC_PREVIEW_MODE = previous
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('/api/connector/rename', () => {
  it('renames a connector, trimming the name, and answers the whole connector', async () => {
    const { connector } = await createConnector('Old name')
    const name = uniqueName('New name')

    const response = await postJson('/api/connector/rename', { id: connector.id, name: `  ${name}  ` })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ connector: { ...connector, name, lastUsedAt: null, calls7d: 0 } })
    expect((await listed(connector.id))?.name).toBe(name)
  })

  it.each([
    ['an empty name', ''],
    ['a name over 64 characters', 'x'.repeat(65)],
    ['a control character', 'bad\u0007name'],
    ['an invisible character', 'bad‎name'],
  ])('refuses %s, as create does', async (_label, name) => {
    const { connector } = await createConnector('Keep name')

    const response = await postJson('/api/connector/rename', { id: connector.id, name })

    expect(response.status).toBe(400)
    expect((await listed(connector.id))?.name).toBe(connector.name)
  })

  it('answers 409 for a revoked connector and 404 for a removed or unknown one', async () => {
    const { connector: revoked } = await createConnector('Revoked')
    await postJson('/api/connector/revoke', { id: revoked.id })
    const { connector: removed } = await createConnector('Removed')
    await postJson('/api/connector/remove', { id: removed.id })

    const onRevoked = await postJson('/api/connector/rename', { id: revoked.id, name: 'x' })
    expect(onRevoked.status).toBe(409)
    expect(await errorCode(onRevoked)).toBe('connector_revoked')
    for (const id of [removed.id, 'missing-id']) {
      const response = await postJson('/api/connector/rename', { id, name: 'x' })
      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('connector_not_found')
    }
  })
})

describe('/api/connector/rotate', () => {
  it('replaces the token: the old one stops working at once, the new one works, the rest stays', async () => {
    const { connector, token: oldToken } = await createConnector('Rotate me', 'full')

    const response = await postJson('/api/connector/rotate', { id: connector.id })

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const { connector: rotated, token } = await response.json() as { connector: ConnectorView, token: string }
    expect(rotated).toMatchObject({ id: connector.id, name: connector.name, level: 'full', createdAt: connector.createdAt, revokedAt: null, rotatedAt: expect.any(Number) })
    expect(token).toMatch(/^sink_mcp_[\w-]{43}$/)
    expect(token).not.toBe(oldToken)
    expect(rotated.hint).toBe(token.slice('sink_mcp_'.length, 'sink_mcp_'.length + 6))
    expect((await listToolsWith(oldToken)).status).toBe(401)
    expect((await listToolsWith(token)).status).toBe(200)
    expect((await listed(connector.id))?.rotatedAt).toBe(rotated.rotatedAt)
  })

  it('keeps the usage history, which is kept by connector id', async () => {
    const { connector } = await createConnector('Busy')
    const today = new Date().toISOString().slice(0, 10)
    await db.insert(mcpUsage).values({ callerId: connector.id, day: today, calls: 7, lastUsedAt: Math.floor(Date.now() / 1000) })

    const { connector: rotated } = await (await postJson('/api/connector/rotate', { id: connector.id })).json() as { connector: ConnectorView }

    expect(rotated.calls7d).toBe(7)
    expect((await listed(connector.id))?.calls7d).toBe(7)
  })

  it('answers 409 without a token for a revoked connector, and 404 for a removed or unknown one', async () => {
    const { connector: revoked, token: revokedToken } = await createConnector('Revoked first')
    await postJson('/api/connector/revoke', { id: revoked.id })
    const [before] = await db.select().from(mcpTokens).where(eq(mcpTokens.id, revoked.id))
    const { connector: removed } = await createConnector('Removed first')
    await postJson('/api/connector/remove', { id: removed.id })

    const onRevoked = await postJson('/api/connector/rotate', { id: revoked.id })
    expect(onRevoked.status).toBe(409)
    expect(await onRevoked.text()).not.toContain('sink_mcp_')
    // Nothing about the revoked row changed, and its token stays refused.
    expect((await db.select().from(mcpTokens).where(eq(mcpTokens.id, revoked.id)))[0]).toEqual(before)
    expect(before?.rotatedAt).toBeNull()
    expect((await listToolsWith(revokedToken)).status).toBe(401)
    for (const id of [removed.id, 'missing-id'])
      expect((await postJson('/api/connector/rotate', { id })).status).toBe(404)
  })
})

describe('/api/connector/remove', () => {
  it('hides an active connector for good, revokes its token, and keeps the row and its usage in D1', async () => {
    const { connector, token } = await createConnector('Remove me')
    const today = new Date().toISOString().slice(0, 10)
    await db.insert(mcpUsage).values({ callerId: connector.id, day: today, calls: 3, lastUsedAt: Math.floor(Date.now() / 1000) })

    const response = await postJson('/api/connector/remove', { id: connector.id })

    expect(response.status).toBe(200)
    const { removedAt } = await response.json() as { id: string, removedAt: number }
    expect(removedAt).toEqual(expect.any(Number))
    expect((await listToolsWith(token)).status).toBe(401)
    expect(await listed(connector.id)).toBeUndefined()
    const [row] = await db.select().from(mcpTokens).where(eq(mcpTokens.id, connector.id))
    expect(row).toMatchObject({ removedAt, revokedAt: removedAt, tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(await db.select().from(mcpUsage).where(eq(mcpUsage.callerId, connector.id))).toEqual([expect.objectContaining({ calls: 3 })])
  })

  it('removes a revoked connector and keeps its revocation time', async () => {
    const { connector } = await createConnector('Revoked then removed')
    const { revokedAt } = await (await postJson('/api/connector/revoke', { id: connector.id })).json() as { revokedAt: number }

    expect((await postJson('/api/connector/remove', { id: connector.id })).status).toBe(200)

    const [row] = await db.select().from(mcpTokens).where(eq(mcpTokens.id, connector.id))
    expect(row?.revokedAt).toBe(revokedAt)
    expect(row?.removedAt).toEqual(expect.any(Number))
  })

  it('answers 404 to every action on a removed connector, and to an unknown id', async () => {
    const { connector } = await createConnector('Gone')
    await postJson('/api/connector/remove', { id: connector.id })

    for (const [path, body] of [
      ['/api/connector/rename', { id: connector.id, name: 'x' }],
      ['/api/connector/rotate', { id: connector.id }],
      ['/api/connector/revoke', { id: connector.id }],
      ['/api/connector/remove', { id: connector.id }],
      ['/api/connector/remove', { id: 'missing-id' }],
    ] as const) {
      const response = await postJson(path, body)
      expect(response.status, path).toBe(404)
      expect(await errorCode(response)).toBe('connector_not_found')
    }
  })
})

describe('connector action logs', () => {
  it('record the id and who acted, never the name or the token', async () => {
    const { connector } = await createConnector('Logged')
    const name = uniqueName('Secret name')
    const lines: unknown[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => void lines.push(...args))

    await postJson('/api/connector/rename', { id: connector.id, name })
    const { token } = await (await postJson('/api/connector/rotate', { id: connector.id })).json() as { token: string }
    await postJson('/api/connector/remove', { id: connector.id })

    for (const event of ['connector.renamed', 'connector.rotated', 'connector.removed'])
      expect(lines).toContainEqual({ event, id: connector.id, authMethod: 'site-token' })
    const text = JSON.stringify(lines)
    expect(text).not.toContain(name)
    expect(text).not.toContain(token)
  })
})

describe('who may rename, rotate and remove connectors', () => {
  const routes = ['/api/connector/rename', '/api/connector/rotate', '/api/connector/remove']

  it('refuses every action without a credential and to a full-level connector token', async () => {
    const { token: attacker } = await createTestConnector('full')
    const { connector, token } = await createConnector('Victim')

    for (const path of routes) {
      for (const headers of [{}, { Authorization: `Bearer ${attacker}` }]) {
        const response = await fetch(path, { method: 'POST', body: JSON.stringify({ id: connector.id, name: 'Taken' }), headers: { 'Content-Type': 'application/json', ...headers } })
        expect(response.status, path).toBe(401)
        expect(await response.text()).not.toContain('sink_mcp_')
      }
    }
    expect(await listed(connector.id)).toMatchObject({ name: connector.name, revokedAt: null })
    expect((await listToolsWith(token)).status).toBe(200)
  })

  it('refuses every action in preview mode', async () => {
    const { connector, token } = await createConnector('Preview')

    await withPreviewMode(async () => {
      for (const path of routes) {
        const response = await postJson(path, { id: connector.id, name: 'Taken' })
        expect(response.status, path).toBe(403)
        expect(await errorCode(response)).toBe('preview_mode')
      }
    })

    expect((await listToolsWith(token)).status).toBe(200)
  })
})
