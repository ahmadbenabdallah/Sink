import type { ConnectorListResponse } from '../../shared/types/connector'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { revokeToken } from '../../server/services/mcp/tokens'
import { createTestConnector, db, deleteStoredLinks, fetch, fetchWithAuth, setLinkStoreD1Mode } from '../utils'

const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  'Mcp-Protocol-Version': '2025-11-25',
}

interface RpcPayload {
  result?: Record<string, any>
  error?: { code: number, message: string }
}

function post(authorization: string, method: string, params: Record<string, unknown> = {}) {
  return fetch('/api/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    headers: { ...HEADERS, Authorization: authorization },
  })
}

async function readPayload(response: Response): Promise<RpcPayload> {
  const text = await response.text()
  const dataLine = text.split('\n').find(line => line.startsWith('data:'))
  return JSON.parse(dataLine ? dataLine.slice(5) : text)
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  return readPayload(await post(`Bearer ${token}`, 'tools/call', { name, arguments: args }))
}

async function listConnectors() {
  const response = await fetchWithAuth('/api/connector/list')
  expect(response.status).toBe(200)
  return await response.json() as ConnectorListResponse
}

async function withAllowSiteToken(value: string, run: () => Promise<void>) {
  const previous = env.NUXT_MCP_ALLOW_SITE_TOKEN
  env.NUXT_MCP_ALLOW_SITE_TOKEN = value
  try {
    await run()
  }
  finally {
    env.NUXT_MCP_ALLOW_SITE_TOKEN = previous
  }
}

/** Runs with the usage table out of reach, as on a deployment that has not applied its migration. */
async function withoutUsageTable(run: () => Promise<void>) {
  await env.DB.prepare('ALTER TABLE mcp_usage RENAME TO mcp_usage_away').run()
  try {
    await run()
  }
  finally {
    await env.DB.prepare('ALTER TABLE mcp_usage_away RENAME TO mcp_usage').run()
  }
}

beforeEach(async () => {
  await setLinkStoreD1Mode()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('when usage cannot be written or read', () => {
  // The daily limit guards a write quota. A database that cannot take the
  // count must not also stop every agent, and must not go unnoticed.
  it('lets the tool call through and logs that it was not counted', async () => {
    const { id, token } = await createTestConnector('read')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    await withoutUsageTable(async () => {
      const payload = await callTool(token, 'count_links')
      expect(payload.result?.isError).toBeUndefined()
      expect(typeof payload.result?.structuredContent?.count).toBe('number')
    })

    const failures = errors.mock.calls.map(([entry]) => entry).filter(entry => entry?.event === 'mcp_usage.count_failed')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ callerId: id })
    expect(JSON.stringify(failures[0])).not.toContain(token)
  })

  // Unknown is not zero: the page must not say "never used" for a connector
  // whose usage could not be read.
  it('still lists connectors, with usage reported as unknown', async () => {
    const { id } = await createTestConnector('read')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await withoutUsageTable(async () => {
      const { connectors, reserved } = await listConnectors()
      expect(connectors.find(connector => connector.id === id)).toMatchObject({ calls7d: null, lastUsedAt: null })
      expect(reserved.length).toBeGreaterThan(0)
      for (const caller of reserved)
        expect(caller).toMatchObject({ calls7d: null, lastUsedAt: null })
    })
  })
})

describe('nUXT_MCP_ALLOW_SITE_TOKEN', () => {
  // Someone who wrote "off" meant off. Only a value that clearly says yes
  // keeps the dashboard password usable on the MCP endpoint.
  it.each(['0', 'no', 'off', 'disabled', '"false"'])('refuses the site token on MCP when set to %s', async (value) => {
    await withAllowSiteToken(value, async () => {
      const refused = await post(`Bearer ${import.meta.env.NUXT_SITE_TOKEN}`, 'tools/list')
      expect(refused.status).toBe(401)
      expect(await refused.json()).toMatchObject({ data: { code: 'site_token_not_allowed' } })
      expect((await fetchWithAuth('/api/verify')).status).toBe(200)
    })
  })

  it.each(['1', 'TRUE'])('accepts the site token on MCP when set to %s', async (value) => {
    await withAllowSiteToken(value, async () => {
      expect((await post(`Bearer ${import.meta.env.NUXT_SITE_TOKEN}`, 'tools/list')).status).toBe(200)
    })
  })

  it('leaves the site token out of the callers list when it is refused on MCP', async () => {
    await withAllowSiteToken('false', async () => {
      const { reserved } = await listConnectors()
      expect(reserved.map(caller => caller.id)).not.toContain('site-token')
    })
    expect((await listConnectors()).reserved.map(caller => caller.id)).toContain('site-token')
  })
})

describe('a connector token that is refused', () => {
  // Probing with a revoked or made-up token must leave a trace.
  it('is logged, without the token', async () => {
    const { id, token } = await createTestConnector('read')
    await revokeToken(db, id)
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await post(`Bearer ${token}`, 'tools/list')).status).toBe(401)

    const refused = warnings.mock.calls.map(([entry]) => entry).filter(entry => entry?.event === 'mcp_token.refused')
    // The line is exactly this: no token, prefix, hint or hash.
    expect(refused).toEqual([{ event: 'mcp_token.refused' }])
  })

  it.each([
    ['a made-up token', `Bearer sink_mcp_${'A'.repeat(43)}`],
    ['a malformed token', 'Bearer sink_mcp_x'],
    ['a lower-case scheme', `bearer sink_mcp_${'A'.repeat(43)}`],
    ['no scheme', `sink_mcp_${'A'.repeat(43)}`],
  ])('is logged for %s', async (_label, authorization) => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await post(authorization, 'tools/list')).status).toBe(401)

    expect(warnings.mock.calls.map(([entry]) => entry).filter(entry => entry?.event === 'mcp_token.refused')).toEqual([{ event: 'mcp_token.refused' }])
  })

  it('is not logged for a request that carries no connector token', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect((await post('Bearer not-a-connector-token', 'tools/list')).status).toBe(401)

    expect(warnings.mock.calls.map(([entry]) => entry).filter(entry => entry?.event === 'mcp_token.refused')).toHaveLength(0)
  })
})

describe('delete_link', () => {
  it('reports the slug it deleted, not the spelling it was sent', async () => {
    const { token } = await createTestConnector('full')
    const slug = `hardening-${crypto.randomUUID().slice(0, 8)}`
    try {
      const created = await callTool(token, 'create_link', { url: 'https://example.com/hardening', slug })
      expect(created.result?.isError).toBeUndefined()

      const deleted = await callTool(token, 'delete_link', { slug: slug.toUpperCase() })
      expect(deleted.result?.structuredContent).toEqual({ slug, deleted: true })
    }
    finally {
      await deleteStoredLinks([slug])
    }
  })
})
