import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyPublicFetchError, fetchPublicHttpUrl } from '../../server/utils/public-url'

type Hop = (input: string, init: RequestInit) => Response

function stubFetch(...hops: Hop[]) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const hop = hops[fetchMock.mock.calls.length - 1]
    if (!hop)
      throw new Error(`Unexpected fetch ${String(input)}`)
    return Promise.resolve(hop(String(input), init))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function redirect(location: string, status = 302): Hop {
  return () => new Response(null, { status, headers: { Location: location } })
}

const ok: Hop = () => new Response('final body')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchPublicHttpUrl', () => {
  it('rejects a private target without fetching', async () => {
    const fetchMock = stubFetch(ok)

    await expect(fetchPublicHttpUrl('http://127.0.0.1/admin')).rejects.toThrow('not allowed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('follows public redirects manually and returns the final response', async () => {
    const fetchMock = stubFetch(redirect('https://b.example/next'), ok)

    const response = await fetchPublicHttpUrl('https://a.example/start')

    expect(await response.text()).toBe('final body')
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['https://a.example/start', 'https://b.example/next'])
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true)
  })

  it('rejects a redirect to a private address without requesting it', async () => {
    const fetchMock = stubFetch(redirect('http://169.254.169.254/latest/meta-data'), ok)

    await expect(fetchPublicHttpUrl('https://a.example/start')).rejects.toThrow('not allowed')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('resolves a relative Location against the current hop', async () => {
    const fetchMock = stubFetch(redirect('/moved?x=1'), ok)

    await fetchPublicHttpUrl('https://a.example/dir/page')

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://a.example/moved?x=1')
  })

  it('follows at most 5 redirects', async () => {
    const loop = redirect('https://a.example/loop')
    const fetchMock = stubFetch(loop, loop, loop, loop, loop, loop, ok)

    await expect(fetchPublicHttpUrl('https://a.example/loop')).rejects.toThrow('Too many redirects')
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('drops Authorization on a cross-origin hop but keeps it on the same origin', async () => {
    const fetchMock = stubFetch(redirect('https://a.example/same'), redirect('https://b.example/other'), ok)

    await fetchPublicHttpUrl('https://a.example/start', { headers: { Authorization: 'Bearer t' } })

    const auth = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))
    expect(auth).toEqual(['Bearer t', 'Bearer t', null])
  })

  it('switches POST to a bodyless GET after a 303', async () => {
    const fetchMock = stubFetch(redirect('https://a.example/result', 303), ok)

    await fetchPublicHttpUrl('https://a.example/form', { method: 'POST', body: 'a=1' })

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'GET', body: undefined })
  })

  it('keeps the method and body on a 307', async () => {
    const fetchMock = stubFetch(redirect('https://a.example/retry', 307), ok)

    await fetchPublicHttpUrl('https://a.example/form', { method: 'POST', body: 'a=1' })

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: 'a=1' })
  })
})

describe('classifyPublicFetchError', () => {
  it('reports a URL refused by the public-URL guard as blocked', async () => {
    const error = await fetchPublicHttpUrl('http://127.0.0.1/').catch(error => error)
    expect(classifyPublicFetchError(error)).toBe('blocked')
  })

  it('reports a redirect chain past the limit as too_many_redirects', async () => {
    stubFetch(...Array.from({ length: 6 }, (_, index) => redirect(`https://example.com/${index}`)))
    const error = await fetchPublicHttpUrl('https://example.com/start').catch(error => error)
    expect(classifyPublicFetchError(error)).toBe('too_many_redirects')
  })

  it('reports an aborted or timed out request as timeout', () => {
    expect(classifyPublicFetchError(new DOMException('The operation timed out', 'TimeoutError'))).toBe('timeout')
    expect(classifyPublicFetchError(new DOMException('The operation was aborted', 'AbortError'))).toBe('timeout')
  })

  it('reports everything else as network, whatever the runtime message says', () => {
    expect(classifyPublicFetchError(new TypeError('internal error; reference = abc123'))).toBe('network')
    expect(classifyPublicFetchError(new Error('Too many redirects'))).toBe('network')
    expect(classifyPublicFetchError('boom')).toBe('network')
  })
})
