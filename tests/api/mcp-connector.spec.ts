import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { revokeToken } from '../../server/services/mcp/tokens'
import { createTestConnector, db, deleteStoredLinks, fetch, fetchWithAuth, setLinkStoreD1Mode } from '../utils'

const MCP_PATH = '/api/mcp'
const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  'Mcp-Protocol-Version': '2025-11-25',
}

const READ_TOOLS = [
  'list_links',
  'search_links',
  'get_link',
  'count_links',
  'list_tags',
  'get_analytics_counters',
  'get_analytics_views',
  'get_analytics_metrics',
  'get_analytics_heatmap',
]
const CREATE_TOOLS = [...READ_TOOLS, 'create_link', 'upsert_link']
const FULL_TOOLS = [...CREATE_TOOLS, 'update_link', 'delete_link', 'check_links']

interface RpcPayload {
  result?: Record<string, any>
  error?: { code: number, message: string }
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` }
}

function postMcp(token: string, method: string, params: Record<string, unknown> = {}, path = MCP_PATH) {
  return fetch(path, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    headers: { ...HEADERS, ...bearer(token) },
  })
}

async function readPayload(response: Response): Promise<RpcPayload> {
  const text = await response.text()
  const dataLine = text.split('\n').find(line => line.startsWith('data:'))
  return JSON.parse(dataLine ? dataLine.slice(5) : text)
}

async function listTools(token: string): Promise<string[]> {
  const response = await postMcp(token, 'tools/list')
  expect(response.status).toBe(200)
  return (await readPayload(response)).result?.tools.map((tool: { name: string }) => tool.name)
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  return readPayload(await postMcp(token, 'tools/call', { name, arguments: args }))
}

beforeEach(async () => {
  await setLinkStoreD1Mode()
})

describe('connector tokens on /api/mcp', () => {
  it.each([
    ['read', READ_TOOLS],
    ['create', CREATE_TOOLS],
    ['full', FULL_TOOLS],
  ] as const)('lists exactly the tools of the %s level', async (level, tools) => {
    const { token } = await createTestConnector(level)
    expect((await listTools(token)).sort()).toEqual([...tools].sort())
  })

  it('lists the level tools on protocol version 2026-07-28 as well', async () => {
    const { token } = await createTestConnector('read')
    const response = await fetch(MCP_PATH, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
      headers: { ...HEADERS, ...bearer(token), 'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
    })
    expect(response.status).toBe(200)

    const payload = await response.json() as RpcPayload
    expect(payload.result?.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...READ_TOOLS].sort())
  })

  it('lets a read token read and refuses it every tool that writes', async () => {
    const { token } = await createTestConnector('read')

    const counted = await callTool(token, 'count_links')
    expect(counted.result?.isError).toBeUndefined()
    expect(typeof counted.result?.structuredContent.count).toBe('number')

    for (const tool of ['create_link', 'upsert_link', 'update_link', 'delete_link', 'check_links']) {
      const refused = await callTool(token, tool, { slug: 'anything', url: 'https://example.com/refused' })
      expect(refused.error?.code, tool).toBe(-32602)
      expect(refused.error?.message, tool).toContain('not found')
    }
  })

  it('lets a create token create a link and refuses it edits and deletes', async () => {
    const { token } = await createTestConnector('create')
    const slug = `connector-${crypto.randomUUID()}`

    try {
      const created = await callTool(token, 'create_link', { url: 'https://example.com/connector-created', slug })
      expect(created.result?.isError).toBeUndefined()
      expect(created.result?.structuredContent.link.slug).toBe(slug)

      for (const tool of ['update_link', 'delete_link', 'check_links']) {
        const refused = await callTool(token, tool, { slug })
        expect(refused.error?.code, tool).toBe(-32602)
      }

      const stillThere = await callTool(token, 'get_link', { slug })
      expect(stillThere.result?.structuredContent.url).toBe('https://example.com/connector-created')
    }
    finally {
      await deleteStoredLinks([slug])
    }
  })

  it('lets a full token change and delete a link', async () => {
    const { token } = await createTestConnector('full')
    const slug = `connector-${crypto.randomUUID()}`

    try {
      await callTool(token, 'create_link', { url: 'https://example.com/connector-full', slug })

      const updated = await callTool(token, 'update_link', { slug, comment: 'changed by a connector' })
      expect(updated.result?.structuredContent.link.comment).toBe('changed by a connector')

      const deleted = await callTool(token, 'delete_link', { slug })
      expect(deleted.result?.structuredContent).toEqual({ slug, deleted: true })
    }
    finally {
      await deleteStoredLinks([slug])
    }
  })

  it('tells the model which level the connection has', async () => {
    const { token } = await createTestConnector('create')
    const response = await postMcp(token, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    })
    expect((await readPayload(response)).result?.instructions).toContain('`create` level')
  })

  // The body is checked, not only the status: a path the MCP handler does not
  // serve can still answer 200 with the application shell.
  it.each([`${MCP_PATH}/`, `${MCP_PATH}?source=test`])('is served by the MCP handler on %s', async (path) => {
    const { token } = await createTestConnector('read')
    const response = await postMcp(token, 'tools/list', {}, path)
    expect(response.status).toBe(200)
    expect((await readPayload(response)).result?.tools).toHaveLength(READ_TOOLS.length)
  })

  it('refuses a call to a tool above the level on protocol version 2026-07-28 as well', async () => {
    const { token } = await createTestConnector('read')
    const response = await fetch(MCP_PATH, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'delete_link',
          arguments: { slug: 'anything' },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
      headers: { ...HEADERS, ...bearer(token), 'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'delete_link' },
    })

    const payload = await response.json() as RpcPayload
    expect(payload.result).toBeUndefined()
    expect(payload.error?.code).toBe(-32602)
  })

  it('refuses a revoked token on the next request', async () => {
    const { id, token } = await createTestConnector('read')
    expect((await postMcp(token, 'tools/list')).status).toBe(200)

    await revokeToken(db, id)

    const response = await postMcp(token, 'tools/list')
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
  })

  it.each([
    ['a token that was never issued', () => `sink_mcp_${'A'.repeat(43)}`],
    ['a token cut short', (token: string) => token.slice(0, -1)],
    ['a token with a different prefix', (token: string) => token.replace('sink_mcp_', 'sink_xyz_')],
  ])('refuses %s', async (_label, change) => {
    const { token } = await createTestConnector('full')
    expect((await postMcp(change(token), 'tools/list')).status).toBe(401)
  })

  // The site token may be sent bare; a connector token may not.
  it('refuses the token when it is sent without the Bearer scheme', async () => {
    const { token } = await createTestConnector('read')
    const response = await fetch(MCP_PATH, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      headers: { ...HEADERS, Authorization: token },
    })
    expect(response.status).toBe(401)
  })

  it.each([
    ['a lower-case scheme', (token: string) => `bearer ${token}`],
    ['two spaces after the scheme', (token: string) => `Bearer  ${token}`],
    ['text after the token', (token: string) => `Bearer ${token} extra`],
  ])('refuses the token sent with %s', async (_label, authorization) => {
    const { token } = await createTestConnector('read')
    const response = await fetch(MCP_PATH, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      headers: { ...HEADERS, Authorization: authorization(token) },
    })
    expect(response.status).toBe(401)
  })

  it('refuses the token with a method other than POST', async () => {
    const { token } = await createTestConnector('full')
    for (const method of ['GET', 'DELETE', 'HEAD', 'OPTIONS']) {
      const response = await fetch(MCP_PATH, { method, headers: bearer(token) })
      expect(response.status, method).toBe(401)
    }
  })
})

describe('connector tokens everywhere else', () => {
  // Every route file under server/api except the MCP one. Reading the list
  // from disk means a route added later is covered without touching this test.
  const routes = Object.keys(import.meta.glob('../../server/api/**/*.ts'))
    .map((file) => {
      const [, path, method] = /^\.\.\/\.\.\/server\/api\/(.+?)(?:\.(get|post|put|delete|patch))?\.ts$/.exec(file)!
      return { path: `/api/${path!.replace('[action]', 'counters')}`, method: (method ?? 'post').toUpperCase() }
    })
    .filter(route => route.path !== MCP_PATH)

  it('finds the API routes', () => {
    expect(routes.length).toBeGreaterThan(25)
    expect(routes).toContainEqual({ path: '/api/link/delete', method: 'POST' })
  })

  it('is refused on every other API route, whatever its level', async () => {
    const { token } = await createTestConnector('full')

    for (const { path, method } of routes) {
      const response = await fetch(path, {
        method,
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      })
      expect(response.status, `${method} ${path}`).toBe(401)
    }
  })

  // `/api/mcp//` is not served by the MCP handler: the router drops one
  // trailing slash, not two.
  it.each(['/api/mcpx', '/api/mcp/tools', '/api/MCP', '/api/mcp.json', '/api/mcp//'])('is refused on the look-alike path %s', async (path) => {
    const { token } = await createTestConnector('full')
    expect((await postMcp(token, 'tools/list', {}, path)).status).toBe(401)
  })

  it('cannot sign in to the dashboard', async () => {
    const { token } = await createTestConnector('full')
    expect((await fetch('/api/verify', { headers: bearer(token) })).status).toBe(401)
  })
})

describe('the site token on /api/mcp', () => {
  function postWithSiteToken() {
    return fetchWithAuth(MCP_PATH, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      headers: HEADERS,
    })
  }

  it('has every tool by default', async () => {
    const response = await postWithSiteToken()
    expect(response.status).toBe(200)
    expect((await readPayload(response)).result?.tools).toHaveLength(FULL_TOOLS.length)
  })

  it('has every tool, by name', async () => {
    const tools = (await readPayload(await postWithSiteToken())).result?.tools.map((tool: { name: string }) => tool.name)
    expect(tools.sort()).toEqual([...FULL_TOOLS].sort())
  })

  it.each(['false', 'FALSE', 'False'])('is refused when NUXT_MCP_ALLOW_SITE_TOKEN is %s, and still works everywhere else', async (value) => {
    const { token } = await createTestConnector('read')
    const previous = env.NUXT_MCP_ALLOW_SITE_TOKEN
    env.NUXT_MCP_ALLOW_SITE_TOKEN = value

    try {
      const refused = await postWithSiteToken()
      expect(refused.status).toBe(401)
      expect(refused.headers.get('WWW-Authenticate')).toBe('Bearer')
      expect(await refused.json()).toMatchObject({ statusMessage: 'Site token is not accepted on MCP', data: { code: 'site_token_not_allowed' } })

      // The other ways of writing the same request are refused as well.
      const bare = await fetch(MCP_PATH, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        headers: { ...HEADERS, Authorization: import.meta.env.NUXT_SITE_TOKEN },
      })
      expect(bare.status).toBe(401)
      const trailingSlash = await fetchWithAuth(`${MCP_PATH}/`, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        headers: HEADERS,
      })
      expect(trailingSlash.status).toBe(401)

      expect((await fetchWithAuth('/api/verify')).status).toBe(200)
      expect((await fetchWithAuth('/api/link/list')).status).toBe(200)
      expect((await postMcp(token, 'tools/list')).status).toBe(200)
    }
    finally {
      env.NUXT_MCP_ALLOW_SITE_TOKEN = previous
    }
  })

  it.each(['true', ''])('is accepted when NUXT_MCP_ALLOW_SITE_TOKEN is %j', async (value) => {
    const previous = env.NUXT_MCP_ALLOW_SITE_TOKEN
    env.NUXT_MCP_ALLOW_SITE_TOKEN = value

    try {
      expect((await postWithSiteToken()).status).toBe(200)
    }
    finally {
      env.NUXT_MCP_ALLOW_SITE_TOKEN = previous
    }
  })
})

describe('an empty site token', () => {
  // If the site token is ever configured as an empty value, a request with no
  // credentials must not be taken for the owner.
  it('authenticates nobody', async () => {
    const previous = env.NUXT_SITE_TOKEN
    env.NUXT_SITE_TOKEN = ''

    try {
      // Proof that the override reached the Worker: the token that normally
      // signs in no longer does.
      expect((await fetchWithAuth('/api/verify')).status).toBe(401)

      expect((await fetch('/api/verify')).status).toBe(401)
      expect((await fetch('/api/verify', { headers: { Authorization: '' } })).status).toBe(401)
      expect((await fetch('/api/verify', { headers: { Authorization: 'Bearer' } })).status).toBe(401)
      expect((await fetch('/api/link/list')).status).toBe(401)
    }
    finally {
      env.NUXT_SITE_TOKEN = previous
    }
  })
})
