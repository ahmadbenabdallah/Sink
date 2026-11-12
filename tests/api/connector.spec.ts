import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpTokens } from '../../server/database/schema'
import { createTestConnector, db, fetch, fetchWithAuth, postJson } from '../utils'

interface ConnectorView {
  id: string
  name: string
  hint: string
  level: string
  createdAt: number
  revokedAt: number | null
  lastUsedAt: number | null
  calls7d: number | null
}

interface ListResponse {
  connectors: ConnectorView[]
  reserved: { id: string, lastUsedAt: number | null, calls7d: number | null }[]
}

interface CreateResponse {
  connector: ConnectorView
  token: string
}

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  'Mcp-Protocol-Version': '2025-11-25',
}

function uniqueName(label: string) {
  return `${label} ${crypto.randomUUID().slice(0, 8)}`
}

async function createConnector(name: string, level: string) {
  const response = await postJson('/api/connector/create', { name, level })
  expect(response.status).toBe(201)
  return await response.json() as CreateResponse
}

async function listConnectors() {
  const response = await fetchWithAuth('/api/connector/list')
  expect(response.status).toBe(200)
  return await response.json() as ListResponse
}

function listToolsWith(token: string) {
  return fetch('/api/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
  })
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

describe('/api/connector/create', () => {
  it('creates a connector and returns its token once', async () => {
    const name = uniqueName('Created')
    const response = await postJson('/api/connector/create', { name, level: 'create' })

    expect(response.status).toBe(201)
    // The answer holds a credential, so nothing may keep a copy of it.
    expect(response.headers.get('Cache-Control')).toBe('no-store')

    const { connector, token } = await response.json() as CreateResponse
    expect(token).toMatch(/^sink_mcp_[\w-]{43}$/)
    expect(connector).toEqual({
      id: expect.any(String),
      name,
      hint: token.slice('sink_mcp_'.length, 'sink_mcp_'.length + 6),
      level: 'create',
      createdAt: expect.any(Number),
      revokedAt: null,
      lastUsedAt: null,
      calls7d: 0,
    })
  })

  it.each([
    ['read', 9],
    ['create', 11],
    ['full', 14],
  ])('creates a %s connector whose token gets %i tools on the MCP endpoint', async (level, tools) => {
    const { token } = await createConnector(uniqueName(level), level)

    const response = await listToolsWith(token)
    expect(response.status).toBe(200)

    const dataLine = (await response.text()).split('\n').find(line => line.startsWith('data:'))
    expect(JSON.parse(dataLine!.slice(5)).result.tools).toHaveLength(tools)
  })

  it('trims the name', async () => {
    const name = uniqueName('Trimmed')
    const { connector } = await createConnector(`  ${name}  `, 'read')
    expect(connector.name).toBe(name)
  })

  it('allows two connectors with the same name and tells them apart by id', async () => {
    const name = uniqueName('Twin')
    const first = await createConnector(name, 'read')
    const second = await createConnector(name, 'read')
    expect(first.connector.id).not.toBe(second.connector.id)
    expect(first.token).not.toBe(second.token)
  })

  it.each([
    ['a missing name', { level: 'read' }],
    ['an empty name', { name: '', level: 'read' }],
    ['a name of only spaces', { name: '   ', level: 'read' }],
    ['a name of only an invisible character', { name: String.fromCharCode(0x200B), level: 'read' }],
    ['a name with a line break', { name: `Line${String.fromCharCode(10)}break`, level: 'read' }],
    ['a name with a text-direction override', { name: `Rev${String.fromCharCode(0x202E)}ersed`, level: 'read' }],
    ['a name over 64 characters', { name: 'n'.repeat(65), level: 'read' }],
    ['a missing level', { name: 'No level' }],
    ['an unknown level', { name: 'Bad level', level: 'admin' }],
    ['a level in the wrong case', { name: 'Bad case', level: 'Full' }],
    ['a level that is not text', { name: 'Bad type', level: 2 }],
  ])('rejects %s', async (_label, body) => {
    const before = (await listConnectors()).connectors.length

    const response = await postJson('/api/connector/create', body)
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('sink_mcp_')

    expect((await listConnectors()).connectors).toHaveLength(before)
  })

  it('accepts a name of exactly 64 characters, accents and symbols included', async () => {
    const name = `${'é'.repeat(60)} ${crypto.randomUUID().slice(0, 3)}`
    expect([...name]).toHaveLength(64)
    expect((await createConnector(name, 'read')).connector.name).toBe(name)
  })

  // A plain HTML form can send this without the browser asking first, so only
  // JSON is accepted.
  it('refuses a body that is not JSON', async () => {
    const before = (await listConnectors()).connectors.length

    const response = await fetchWithAuth('/api/connector/create', {
      method: 'POST',
      body: 'name=From+a+form&level=full',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    expect(response.status).toBe(415)

    expect((await listConnectors()).connectors).toHaveLength(before)
  })

  it('records who created the connector, without the token', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { connector, token } = await createConnector(uniqueName('Logged'), 'full')

    expect(log).toHaveBeenCalledWith({ event: 'connector.created', id: connector.id, level: 'full', authMethod: 'site-token' })
    expect(JSON.stringify(log.mock.calls)).not.toContain(token)
  })

  it('stores only what it was asked for when the body carries extra fields', async () => {
    const name = uniqueName('Extra fields')
    const response = await postJson('/api/connector/create', { name, level: 'read', id: 'chosen-id', revokedAt: 1, tokenHash: 'x' })
    expect(response.status).toBe(201)

    const { connector } = await response.json() as CreateResponse
    expect(connector.id).not.toBe('chosen-id')
    expect(connector.revokedAt).toBeNull()
  })
})

describe('/api/connector/list', () => {
  it('lists connectors newest first, without tokens or hashes', async () => {
    const first = await createConnector(uniqueName('Listed 1'), 'read')
    const second = await createConnector(uniqueName('Listed 2'), 'full')

    const response = await fetchWithAuth('/api/connector/list')
    const body = await response.text()
    expect(body).not.toContain(first.token)
    expect(body).not.toContain(second.token)
    expect(body).not.toContain('tokenHash')
    expect(body).not.toContain('token_hash')

    const { connectors } = JSON.parse(body) as ListResponse
    const position = (id: string) => connectors.findIndex(connector => connector.id === id)
    expect(position(second.connector.id)).toBeLessThan(position(first.connector.id))
    expect(connectors[position(second.connector.id)]).toEqual(second.connector)
  })

  // The site token is always a caller of its own.
  it('lists the site token as the only reserved caller when Cloudflare Access is not configured', async () => {
    const previous = { teamDomain: env.NUXT_CF_ACCESS_TEAM_DOMAIN, audience: env.NUXT_CF_ACCESS_AUD }
    env.NUXT_CF_ACCESS_TEAM_DOMAIN = ''
    env.NUXT_CF_ACCESS_AUD = ''

    try {
      expect((await listConnectors()).reserved).toEqual([{ id: 'site-token', lastUsedAt: expect.toBeOneOf([null, expect.any(Number)]), calls7d: expect.any(Number) }])
    }
    finally {
      env.NUXT_CF_ACCESS_TEAM_DOMAIN = previous.teamDomain
      env.NUXT_CF_ACCESS_AUD = previous.audience
    }
  })

  it('lists Cloudflare Access as a reserved caller when it is configured', async () => {
    const previous = { teamDomain: env.NUXT_CF_ACCESS_TEAM_DOMAIN, audience: env.NUXT_CF_ACCESS_AUD }
    env.NUXT_CF_ACCESS_TEAM_DOMAIN = 'https://connector-test.cloudflareaccess.com'
    env.NUXT_CF_ACCESS_AUD = 'connector-test-audience'

    try {
      const { reserved } = await listConnectors()
      expect(reserved.map(row => row.id)).toEqual(['site-token', 'access'])
    }
    finally {
      env.NUXT_CF_ACCESS_TEAM_DOMAIN = previous.teamDomain
      env.NUXT_CF_ACCESS_AUD = previous.audience
    }
  })
})

describe('/api/connector/revoke', () => {
  it('revokes a connector, and its token stops working at once', async () => {
    const { connector, token } = await createConnector(uniqueName('Revoked'), 'full')
    expect((await listToolsWith(token)).status).toBe(200)

    const response = await postJson('/api/connector/revoke', { id: connector.id })
    expect(response.status).toBe(200)
    const revoked = await response.json() as { id: string, revokedAt: number }
    expect(revoked).toEqual({ id: connector.id, revokedAt: expect.any(Number) })

    expect((await listToolsWith(token)).status).toBe(401)

    const listed = (await listConnectors()).connectors.find(row => row.id === connector.id)
    expect(listed?.revokedAt).toBe(revoked.revokedAt)
  })

  it('answers a second revoke with the original time', async () => {
    const { connector } = await createConnector(uniqueName('Revoked twice'), 'read')
    const first = await (await postJson('/api/connector/revoke', { id: connector.id })).json() as { revokedAt: number }

    // Move the stored time, so a second revoke that wrote "now" would show.
    await db.update(mcpTokens).set({ revokedAt: first.revokedAt - 100 }).where(eq(mcpTokens.id, connector.id))

    const second = await postJson('/api/connector/revoke', { id: connector.id })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ id: connector.id, revokedAt: first.revokedAt - 100 })
  })

  it('records who revoked the connector', async () => {
    const { connector } = await createConnector(uniqueName('Revoke logged'), 'read')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await postJson('/api/connector/revoke', { id: connector.id })

    expect(log).toHaveBeenCalledWith({ event: 'connector.revoked', id: connector.id, authMethod: 'site-token' })
  })

  it('refuses a body that is not JSON', async () => {
    const { connector, token } = await createConnector(uniqueName('Form revoke'), 'read')

    const response = await fetchWithAuth('/api/connector/revoke', {
      method: 'POST',
      body: `id=${connector.id}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    expect(response.status).toBe(415)
    expect((await listToolsWith(token)).status).toBe(200)
  })

  it('answers 404 for a connector that does not exist', async () => {
    const response = await postJson('/api/connector/revoke', { id: 'no-such-connector' })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ data: { code: 'connector_not_found' } })
  })

  it.each([
    ['a missing id', {}],
    ['an empty id', { id: '' }],
    ['an id that is not text', { id: 42 }],
  ])('rejects %s', async (_label, body) => {
    expect((await postJson('/api/connector/revoke', body)).status).toBe(400)
  })
})

describe('who may manage connectors', () => {
  function request(method: string, path: string, body: unknown, token?: string) {
    return fetch(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
  }

  it('refuses every route without a credential', async () => {
    const { connector, token } = await createConnector(uniqueName('Untouched'), 'read')

    expect((await request('GET', '/api/connector/list', undefined)).status).toBe(401)
    expect((await request('POST', '/api/connector/create', { name: 'Not allowed', level: 'full' })).status).toBe(401)
    expect((await request('POST', '/api/connector/revoke', { id: connector.id })).status).toBe(401)

    expect((await listToolsWith(token)).status).toBe(200)
  })

  // A connector must never be able to mint or revoke connectors: one leaked
  // token would otherwise become as many as its holder wants.
  it('refuses every route to a full-level connector token', async () => {
    const { token: attacker } = await createTestConnector('full')
    const { connector: victim, token: victimToken } = await createConnector(uniqueName('Victim'), 'read')
    const name = uniqueName('Minted by a connector')

    const listed = await request('GET', '/api/connector/list', undefined, attacker)
    expect(listed.status).toBe(401)
    expect(await listed.text()).not.toContain(victim.id)

    const created = await request('POST', '/api/connector/create', { name, level: 'full' }, attacker)
    expect(created.status).toBe(401)
    expect(await created.text()).not.toContain('sink_mcp_')

    expect((await request('POST', '/api/connector/revoke', { id: victim.id }, attacker)).status).toBe(401)

    const { connectors } = await listConnectors()
    expect(connectors.map(connector => connector.name)).not.toContain(name)
    expect(connectors.find(connector => connector.id === victim.id)?.revokedAt).toBeNull()
    expect((await listToolsWith(victimToken)).status).toBe(200)
  })

  it('refuses to create or revoke in preview mode, and still lists', async () => {
    const { connector, token } = await createConnector(uniqueName('Before preview'), 'read')

    await withPreviewMode(async () => {
      const created = await postJson('/api/connector/create', { name: uniqueName('In preview'), level: 'read' })
      expect(created.status).toBe(403)
      expect(await created.json()).toMatchObject({ data: { code: 'preview_mode' } })

      const revoked = await postJson('/api/connector/revoke', { id: connector.id })
      expect(revoked.status).toBe(403)

      expect((await fetchWithAuth('/api/connector/list')).status).toBe(200)
    })

    expect((await listToolsWith(token)).status).toBe(200)
  })
})
