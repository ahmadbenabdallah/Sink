import type { JSONWebKeySet } from 'jose'
import { env } from 'cloudflare:workers'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { revokeToken } from '../server/services/mcp/tokens'
import {
  isCloudflareAccessConfigured,
  isCloudflareAccessRequestSafe,
  mapCloudflareAccessIdentity,
  verifyCloudflareAccessToken,
} from '../server/utils/cloudflare-access'
import { createTestConnector, db, fetch, fetchWithAuth, setLinkStoreD1Mode } from './utils'

const issuer = 'https://sink.cloudflareaccess.com'
const audience = 'sink-audience'
const keyId = 'sink-test-key'

let privateKey: CryptoKey
let localJwks: ReturnType<typeof createLocalJWKSet>
let publicJwks: JSONWebKeySet

beforeAll(async () => {
  const keyPair = await generateKeyPair('RS256', { extractable: true })
  privateKey = keyPair.privateKey

  const publicJwk = await exportJWK(keyPair.publicKey)
  publicJwks = {
    keys: [{
      ...publicJwk,
      alg: 'RS256',
      kid: keyId,
      use: 'sig',
    }],
  }
  localJwks = createLocalJWKSet(publicJwks)
})

interface TokenOptions {
  aud?: string
  exp?: number
  iss?: string
  key?: CryptoKey
  omitAudience?: boolean
  omitExp?: boolean
  omitIssuer?: boolean
  payload?: Record<string, unknown>
}

async function createToken(options: TokenOptions = {}) {
  const now = Math.floor(Date.now() / 1000)
  let token = new SignJWT({
    type: 'app',
    sub: 'access-user-id',
    email: 'alice@example.com',
    ...options.payload,
  })
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .setIssuedAt(now)
    .setNotBefore(now)

  if (!options.omitIssuer)
    token = token.setIssuer(options.iss || issuer)

  if (!options.omitAudience)
    token = token.setAudience(options.aud || audience)

  if (!options.omitExp)
    token = token.setExpirationTime(options.exp ?? now + 300)

  return await token.sign(options.key || privateKey)
}

describe('cloudflare Access JWT validation', () => {
  it('accepts a valid user token', async () => {
    const token = await createToken()
    await expect(verifyCloudflareAccessToken(token, { issuer, audience }, localJwks)).resolves.toEqual({
      kind: 'user',
      userID: 'access-user-id',
      userEmail: 'alice@example.com',
    })
  })

  it.each([
    ['missing subject', { sub: undefined }],
    ['blank subject', { sub: '  ' }],
    ['non-string subject', { sub: 123 }],
    ['missing email', { email: undefined }],
    ['blank email', { email: '  ' }],
    ['non-string email', { email: 123 }],
    ['missing type', { type: undefined }],
    ['incorrect type', { type: 'service' }],
    ['mixed user and service claims', { common_name: 'service-client-id' }],
  ])('rejects a user token with %s', async (_name, payload) => {
    const token = await createToken({ payload })
    await expect(verifyCloudflareAccessToken(token, { issuer, audience }, localJwks)).resolves.toBeNull()
  })

  it('accepts an official-shape service token', async () => {
    const token = await createToken({
      payload: {
        sub: '',
        email: undefined,
        common_name: 'service-client-id',
      },
    })
    await expect(verifyCloudflareAccessToken(token, { issuer, audience }, localJwks)).resolves.toEqual({
      kind: 'service',
    })
  })

  it('rejects a service token with an empty email', async () => {
    const token = await createToken({
      payload: {
        sub: '',
        email: '',
        common_name: 'service-client-id',
      },
    })
    await expect(verifyCloudflareAccessToken(token, { issuer, audience }, localJwks)).resolves.toBeNull()
  })

  it.each([
    ['missing common name', { sub: '', email: undefined, common_name: undefined }],
    ['blank common name', { sub: '', email: undefined, common_name: '' }],
    ['non-string common name', { sub: '', email: undefined, common_name: 123 }],
    ['non-empty subject', { sub: 'access-user-id', email: undefined, common_name: 'service-client-id' }],
    ['email claim', { sub: '', email: 'alice@example.com', common_name: 'service-client-id' }],
    ['incorrect type', { type: 'service', sub: '', email: undefined, common_name: 'service-client-id' }],
    ['missing subject', { sub: undefined, email: undefined, common_name: 'service-client-id' }],
    ['ambiguous blank claims', { sub: '', email: '', common_name: '' }],
  ])('rejects a service token with %s', async (_name, payload) => {
    const token = await createToken({ payload })
    await expect(verifyCloudflareAccessToken(token, { issuer, audience }, localJwks)).resolves.toBeNull()
  })

  it('rejects an invalid audience', async () => {
    const token = await createToken({ aud: 'other-audience' })
    await expect(verifyCloudflareAccessToken(token, { issuer, audience }, localJwks)).resolves.toBeNull()
  })

  it('rejects an invalid issuer', async () => {
    const token = await createToken({ iss: 'https://other.cloudflareaccess.com' })
    await expect(verifyCloudflareAccessToken(token, { issuer, audience }, localJwks)).resolves.toBeNull()
  })

  it('rejects a token without an issuer', async () => {
    const token = await createToken({ omitIssuer: true })
    await expect(verifyCloudflareAccessToken(token, { issuer, audience }, localJwks)).resolves.toBeNull()
  })

  it('rejects a token without an audience', async () => {
    const token = await createToken({ omitAudience: true })
    await expect(verifyCloudflareAccessToken(token, { issuer, audience }, localJwks)).resolves.toBeNull()
  })

  it('rejects an expired token', async () => {
    const token = await createToken({ exp: Math.floor(Date.now() / 1000) - 60 })
    await expect(verifyCloudflareAccessToken(token, { issuer, audience }, localJwks)).resolves.toBeNull()
  })

  it('rejects a token without an expiration claim', async () => {
    const token = await createToken({ omitExp: true })
    await expect(verifyCloudflareAccessToken(token, { issuer, audience }, localJwks)).resolves.toBeNull()
  })

  it('rejects a token with an invalid signature', async () => {
    const otherKeyPair = await generateKeyPair('RS256')
    const token = await createToken({ key: otherKeyPair.privateKey })
    await expect(verifyCloudflareAccessToken(token, { issuer, audience }, localJwks)).resolves.toBeNull()
  })

  it('fails closed when the key source is unavailable', async () => {
    const token = await createToken()
    const unavailableJwks = async () => {
      throw new Error('JWKS unavailable')
    }
    await expect(verifyCloudflareAccessToken(token, { issuer, audience }, unavailableJwks)).resolves.toBeNull()
  })
})

describe('cloudflare Access identity mapping', () => {
  it('maps a service identity to root authentication', () => {
    expect(mapCloudflareAccessIdentity({ kind: 'service' }, 'sink.example.com')).toEqual({
      authMethod: 'access-service',
      userID: 'root',
      userEmail: 'root@sink.example.com',
    })
  })
})

describe('cloudflare Access configuration', () => {
  it('requires both configuration values', () => {
    expect(isCloudflareAccessConfigured(issuer, audience)).toBe(true)
    expect(isCloudflareAccessConfigured('', audience)).toBe(false)
    expect(isCloudflareAccessConfigured(issuer, '')).toBe(false)
    expect(isCloudflareAccessConfigured(' ', ' ')).toBe(false)
  })
})

describe('cloudflare Access CSRF protection', () => {
  it('rejects cross-site browser requests', () => {
    expect(isCloudflareAccessRequestSafe({
      method: 'GET',
      requestOrigin: 'https://sink.example.com',
      secFetchSite: 'cross-site',
    })).toBe(false)
  })

  it('rejects unsafe requests from another origin', () => {
    expect(isCloudflareAccessRequestSafe({
      method: 'POST',
      origin: 'https://attacker.example.com',
      requestOrigin: 'https://sink.example.com',
      secFetchSite: 'same-site',
    })).toBe(false)
  })

  it('accepts same-origin unsafe requests and non-browser clients', () => {
    expect(isCloudflareAccessRequestSafe({
      method: 'POST',
      origin: 'https://sink.example.com',
      requestOrigin: 'https://sink.example.com',
      secFetchSite: 'same-origin',
    })).toBe(true)
    expect(isCloudflareAccessRequestSafe({
      method: 'POST',
      requestOrigin: 'https://sink.example.com',
    })).toBe(true)
  })

  it('rejects cookie-authenticated unsafe requests without an origin', () => {
    expect(isCloudflareAccessRequestSafe({
      method: 'POST',
      hasAccessCookie: true,
      requestOrigin: 'https://sink.example.com',
    })).toBe(false)
  })
})

describe('cloudflare Access request authentication', () => {
  it('does not apply Access CSRF restrictions to site-token writes', async () => {
    await setLinkStoreD1Mode()
    const response = await fetchWithAuth('/api/link/create', {
      method: 'POST',
      body: '{}',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': 'CF_Authorization=access-cookie',
        'Origin': 'https://attacker.example.com',
        'Sec-Fetch-Site': 'cross-site',
      },
    })

    expect([401, 403]).not.toContain(response.status)
  })

  // The Worker fetches the Access signing keys from the team domain, so the
  // key set is served through a stubbed fetch. The team domain is unique to
  // this test because the Worker caches one key set per domain.
  it('lets a Cloudflare Access identity call MCP tools', async () => {
    await setLinkStoreD1Mode()
    const teamDomain = 'https://sink-mcp-test.cloudflareaccess.com'
    const previous = { teamDomain: env.NUXT_CF_ACCESS_TEAM_DOMAIN, audience: env.NUXT_CF_ACCESS_AUD }
    env.NUXT_CF_ACCESS_TEAM_DOMAIN = teamDomain
    env.NUXT_CF_ACCESS_AUD = audience
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === `${teamDomain}/cdn-cgi/access/certs`)
        return Response.json(publicJwks)
      throw new Error(`Blocked test outbound request to ${url}`)
    })

    try {
      const response = await fetch('/api/mcp', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'count_links', arguments: {} } }),
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Mcp-Protocol-Version': '2025-11-25',
          'Cf-Access-Jwt-Assertion': await createToken({ iss: teamDomain }),
        },
      })
      expect(response.status).toBe(200)

      const dataLine = (await response.text()).split('\n').find(line => line.startsWith('data:'))
      const payload = JSON.parse(dataLine!.slice(5)) as { result?: { isError?: boolean, structuredContent?: { count?: unknown } } }
      expect(payload.result?.isError).toBeUndefined()
      expect(typeof payload.result?.structuredContent?.count).toBe('number')
    }
    finally {
      fetchSpy.mockRestore()
      env.NUXT_CF_ACCESS_TEAM_DOMAIN = previous.teamDomain
      env.NUXT_CF_ACCESS_AUD = previous.audience
    }
  })

  // With Access in front of the MCP endpoint, an agent's request carries an
  // Access identity as well as its connector token. The connector is the
  // narrower identity, and the one the owner can revoke and count.
  it('gives a request with a connector token the rights of the connector, even with an Access identity', async () => {
    await setLinkStoreD1Mode()
    const teamDomain = 'https://sink-mcp-connector-test.cloudflareaccess.com'
    const previous = { teamDomain: env.NUXT_CF_ACCESS_TEAM_DOMAIN, audience: env.NUXT_CF_ACCESS_AUD }
    env.NUXT_CF_ACCESS_TEAM_DOMAIN = teamDomain
    env.NUXT_CF_ACCESS_AUD = audience
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === `${teamDomain}/cdn-cgi/access/certs`)
        return Response.json(publicJwks)
      throw new Error(`Blocked test outbound request to ${url}`)
    })
    const assertion = await createToken({ iss: teamDomain })
    const listTools = (authorization?: string) => fetch('/api/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Protocol-Version': '2025-11-25',
        'Cf-Access-Jwt-Assertion': assertion,
        ...(authorization ? { Authorization: authorization } : {}),
      },
    })
    const toolNames = async (response: Response) => {
      const dataLine = (await response.text()).split('\n').find(line => line.startsWith('data:'))
      return (JSON.parse(dataLine!.slice(5)) as { result: { tools: { name: string }[] } }).result.tools.map(tool => tool.name)
    }

    try {
      // Proof that the Access identity alone is accepted here, with every tool.
      const accessOnly = await listTools()
      expect(accessOnly.status).toBe(200)
      expect(await toolNames(accessOnly)).toContain('delete_link')

      const { id, token } = await createTestConnector('read')
      const withConnector = await listTools(`Bearer ${token}`)
      expect(withConnector.status).toBe(200)
      const names = await toolNames(withConnector)
      expect(names).toContain('list_links')
      expect(names).not.toContain('create_link')
      expect(names).not.toContain('delete_link')

      // A connector token written any other way is refused, not passed over
      // for the Access identity: a misspelt header must not quietly turn a
      // read agent into a full one.
      for (const authorization of [`bearer ${token}`, `Bearer  ${token}`, token])
        expect((await listTools(authorization)).status).toBe(401)

      // Revoking cuts the agent off, Access identity or not.
      await revokeToken(db, id)
      expect((await listTools(`Bearer ${token}`)).status).toBe(401)
    }
    finally {
      fetchSpy.mockRestore()
      env.NUXT_CF_ACCESS_TEAM_DOMAIN = previous.teamDomain
      env.NUXT_CF_ACCESS_AUD = previous.audience
    }
  })
})
