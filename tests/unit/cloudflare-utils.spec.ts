import type { H3Event } from 'h3'
import type { SelectQueryBuilder } from 'kysely'
import { sql } from 'kysely'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeAccessLog } from '../../server/utils/access-log'
import { compileAnalyticsQuery, createAnalyticsQuery } from '../../server/utils/analytics-sql'
import { useWAE } from '../../server/utils/cloudflare'

vi.mock('#shared/utils/flag', () => ({ getFlag: vi.fn() }))

/** A D1 binding whose `deleted_link_ids` read returns `deleted`, or fails. */
function deletedLinksDatabase(deleted: string[] | Error) {
  const bind = vi.fn(() => ({
    all: async () => {
      if (deleted instanceof Error)
        throw deleted
      return { results: deleted.map(id => ({ id })) }
    },
  }))
  return { prepare: vi.fn(() => ({ bind })), bind }
}

function eventWith(DB: unknown = deletedLinksDatabase([])) {
  return {
    context: {
      cloudflare: { env: { DB } },
      link: { id: 'link-id' },
    },
  } as unknown as H3Event
}

const event = eventWith()

const query = createAnalyticsQuery('sink').select('index1') as unknown as SelectQueryBuilder<any, any, any>

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
  ])('returns empty data without requesting when credentials are incomplete', async (config) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('$fetch', fetchMock)

    await expect(useWAE(event, query)).resolves.toEqual({ data: [] })
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
    expect(error.data).toEqual({ code: 'cloudflare_credentials_rejected' })
    expect(JSON.stringify(error)).not.toMatch(/secret-token|upstream-body/)
  })

  it.each([400, 429, 500])('reports an upstream %i as a 502 without relaying its status or body', async (status) => {
    stubUpstreamFailure(status)

    const error = await Promise.resolve(useWAE(event, query)).then(() => null, error => error)

    expect(error).toMatchObject({ statusCode: 502, statusMessage: 'Cloudflare API request failed' })
    expect(error.data).toEqual({ code: 'cloudflare_request_failed' })
    expect(JSON.stringify(error)).not.toMatch(/secret-token|upstream-body/)
  })
})

describe('useWAE leaves out links the owner deleted', () => {
  const filtered = createAnalyticsQuery('sink')
    .select([sql.ref('blob1').as('slug'), sql<number>`SUM(_sample_interval)`.as('visits')])
    .where(sql<boolean>`blob1 in ('a')`)
    .groupBy('slug')
    .limit(sql.lit(10)) as unknown as SelectQueryBuilder<any, any, any>

  function stubAnalyticsEngine() {
    const fetchMock = vi.fn().mockResolvedValue({ data: [] })
    vi.stubGlobal('useRuntimeConfig', () => ({ cfAccountId: 'account', cfApiToken: 'token' }))
    vi.stubGlobal('compileAnalyticsQuery', compileAnalyticsQuery)
    vi.stubGlobal('$fetch', fetchMock)
    return fetchMock
  }

  it('adds the ids deleted in the last 92 days to every query, escaped', async () => {
    const fetchMock = stubAnalyticsEngine()
    const DB = deletedLinksDatabase(['id-1', `it's`])
    const now = Date.UTC(2026, 10, 14)
    vi.spyOn(Date, 'now').mockReturnValue(now)

    await useWAE(eventWith(DB), filtered)

    expect(DB.prepare).toHaveBeenCalledWith('SELECT id FROM deleted_link_ids WHERE deleted_at >= ? ORDER BY deleted_at DESC LIMIT 2001')
    expect(DB.bind).toHaveBeenCalledWith(now / 1000 - 92 * 86_400)
    expect(fetchMock.mock.calls[0]![1].body).toBe(`select blob1 as slug, SUM(_sample_interval) as visits from sink where blob1 in ('a') and index1 not in ('id-1', 'it''s') group by slug limit 10`)
  })

  it('uses only the 2,000 most recent deletions, so a long list cannot break every query', async () => {
    const fetchMock = stubAnalyticsEngine()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ids = Array.from({ length: 2001 }, (_, i) => `id-${i}`)

    await useWAE(eventWith(deletedLinksDatabase(ids)), filtered)

    const body = String(fetchMock.mock.calls[0]![1].body)
    expect(body).toContain(`'id-1999')`)
    expect(body).not.toContain(`'id-2000'`)
    expect(warn).toHaveBeenCalledWith({ event: 'deleted_link_ids.over_cap', cap: 2000 })
  })

  it('leaves out ids with control characters, which Analytics Engine queries must not carry', async () => {
    const fetchMock = stubAnalyticsEngine()

    await useWAE(eventWith(deletedLinksDatabase(['ok', 'nul\u0000id', 'new\nline', 'del\u007Fid'])), filtered)

    expect(fetchMock.mock.calls[0]![1].body).toContain(`and index1 not in ('ok') group by`)
  })

  it('leaves the query unchanged when no link was deleted', async () => {
    const fetchMock = stubAnalyticsEngine()

    await useWAE(eventWith(deletedLinksDatabase([])), filtered)

    expect(fetchMock.mock.calls[0]![1].body).toBe(`select blob1 as slug, SUM(_sample_interval) as visits from sink where blob1 in ('a') group by slug limit 10`)
  })

  it('answers 502 without querying Analytics Engine when the list cannot be read', async () => {
    const fetchMock = stubAnalyticsEngine()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(useWAE(eventWith(deletedLinksDatabase(new Error('D1 down'))), filtered)).rejects.toMatchObject({ statusCode: 502, statusMessage: 'Cloudflare API request failed' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
