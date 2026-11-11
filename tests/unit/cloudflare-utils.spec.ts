import type { H3Event } from 'h3'
import type { Compilable } from 'kysely'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeAccessLog } from '../../server/utils/access-log'
import { useWAE } from '../../server/utils/cloudflare'

vi.mock('#shared/utils/flag', () => ({ getFlag: vi.fn() }))

const event = {
  context: {
    cloudflare: { env: {} },
    link: { id: 'link-id' },
  },
} as unknown as H3Event

const query = {} as Compilable

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('writeAccessLog', () => {
  it('silently skips production writes without an Analytics Engine binding', () => {
    vi.stubEnv('NODE_ENV', 'production')

    expect(() => writeAccessLog(event, {})).not.toThrow()
  })
})

describe('useWAE', () => {
  it.each([
    { cfAccountId: '', cfApiToken: 'token' },
    { cfAccountId: 'account', cfApiToken: '' },
  ])('returns empty data without requesting when credentials are incomplete', (config) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('$fetch', fetchMock)

    expect(useWAE(event, query)).toEqual({ data: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves requests and reports a failed call as a 502 when credentials are complete', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('useRuntimeConfig', () => ({
      cfAccountId: 'account',
      cfApiToken: 'token',
    }))
    vi.stubGlobal('compileAnalyticsQuery', () => 'select * from sink')
    vi.stubGlobal('$fetch', fetchMock)

    await expect(useWAE(event, query)).rejects.toMatchObject({ statusCode: 502, statusMessage: 'Cloudflare API request failed' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account/analytics_engine/sql',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: 'select * from sink',
        retry: 1,
        retryDelay: 100,
      },
    )
  })

  function stubUpstreamFailure(status: number) {
    const upstream = Object.assign(new Error('upstream'), {
      status,
      statusCode: status,
      data: { errors: [{ message: 'upstream-body' }] },
    })
    vi.stubGlobal('useRuntimeConfig', () => ({ cfAccountId: 'account', cfApiToken: 'secret-token' }))
    vi.stubGlobal('compileAnalyticsQuery', () => 'select * from sink')
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(upstream))
    return upstream
  }

  it.each([401, 403])('reports an upstream %i as a 502 so the client does not treat it as a site auth failure', async (status) => {
    stubUpstreamFailure(status)

    const error = await Promise.resolve(useWAE(event, query)).then(() => null, error => error)

    expect(error).toMatchObject({
      statusCode: 502,
      statusMessage: 'Cloudflare API rejected the configured credentials',
    })
    expect(error.data).toBeUndefined()
    expect(JSON.stringify(error)).not.toMatch(/secret-token|upstream-body/)
  })

  it.each([400, 429, 500])('reports an upstream %i as a 502 without relaying its status or body', async (status) => {
    stubUpstreamFailure(status)

    const error = await Promise.resolve(useWAE(event, query)).then(() => null, error => error)

    expect(error).toMatchObject({ statusCode: 502, statusMessage: 'Cloudflare API request failed' })
    expect(error.data).toBeUndefined()
    expect(JSON.stringify(error)).not.toMatch(/secret-token|upstream-body/)
  })
})
