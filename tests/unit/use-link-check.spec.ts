import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLinkCheck } from '../../app/composables/useLinkCheck'

const { useAPIMock } = vi.hoisted(() => ({
  useAPIMock: vi.fn(),
}))

vi.mock('@/utils/api', () => ({ useAPI: useAPIMock }))

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('useLinkCheck', () => {
  beforeEach(() => {
    useAPIMock.mockReset()
  })

  it('loads only the total before checking', async () => {
    useAPIMock.mockResolvedValue({ count: 12 })
    const linkCheck = useLinkCheck()

    await linkCheck.loadLinks()

    expect(useAPIMock).toHaveBeenCalledOnce()
    expect(useAPIMock).toHaveBeenCalledWith('/api/link/count', {
      query: { status: 'all' },
    })
    expect(linkCheck.totalCount.value).toBe(12)
    expect(linkCheck.hasLinks.value).toBe(true)
    expect(linkCheck.links.value).toEqual([])
  })

  it('checks cursor pages without sending client-side links', async () => {
    useAPIMock
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({
        results: [{ slug: 'first', url: 'https://example.com/first', status: 200, ok: true, duration: 1, checkedAt: 'now' }],
        cursor: 'next-page',
        list_complete: false,
      })
      .mockResolvedValueOnce({
        results: [
          { slug: 'first', url: 'https://example.com/replaced', status: 301, ok: true, duration: 1, checkedAt: 'later' },
          { slug: 'second', url: 'https://example.com/second', status: 404, ok: false, duration: 1, checkedAt: 'now' },
        ],
        list_complete: true,
      })
    const linkCheck = useLinkCheck()
    await linkCheck.loadLinks()

    const outcome = await linkCheck.startCheck({ batchSize: 10, timeout: 5 })

    expect(outcome).toBe('completed')
    expect(linkCheck.results.value).toHaveLength(2)
    expect(linkCheck.results.value.map(result => result.slug)).toEqual(['first', 'second'])
    expect(linkCheck.links.value).toHaveLength(2)
    expect(useAPIMock).toHaveBeenNthCalledWith(2, '/api/link/check', {
      method: 'POST',
      body: { cursor: undefined, limit: 10, timeout: 5 },
    })
    expect(useAPIMock).toHaveBeenNthCalledWith(3, '/api/link/check', {
      method: 'POST',
      body: { cursor: 'next-page', limit: 10, timeout: 5 },
    })
    for (const [, options] of useAPIMock.mock.calls.slice(1))
      expect(options.body).not.toHaveProperty('links')
  })

  // Pages are requested back to back otherwise, so a check over fast targets
  // could send hundreds of requests a minute and run into the API rate limit.
  it('pauses between pages, but not after the last one', async () => {
    const page = (slug: string, cursor?: string) => ({
      results: [{ slug, url: `https://example.com/${slug}`, status: 200, ok: true, duration: 1, checkedAt: 'now' }],
      cursor,
      list_complete: !cursor,
    })
    useAPIMock
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce(page('first', 'page-2'))
      .mockResolvedValueOnce(page('second', 'page-3'))
      .mockResolvedValueOnce(page('third'))
    const delay = vi.fn(async (_ms: number) => {})
    const linkCheck = useLinkCheck({ delay })
    await linkCheck.loadLinks()

    await expect(linkCheck.startCheck({ batchSize: 1, timeout: 5 })).resolves.toBe('completed')

    expect(linkCheck.results.value).toHaveLength(3)
    expect(delay.mock.calls).toEqual([[250], [250]])
  })

  it('does not request another page after stop is requested', async () => {
    const page = createDeferred<{
      results: { slug: string, url: string, status: number, ok: boolean, duration: number, checkedAt: string }[]
      cursor: string
      list_complete: boolean
    }>()
    useAPIMock
      .mockResolvedValueOnce({ count: 2 })
      .mockReturnValueOnce(page.promise)
    const linkCheck = useLinkCheck()
    await linkCheck.loadLinks()

    const checking = linkCheck.startCheck({ batchSize: 1, timeout: 6 })
    linkCheck.stopCheck()
    page.resolve({
      results: [{ slug: 'first', url: 'https://example.com', status: 200, ok: true, duration: 1, checkedAt: 'now' }],
      cursor: 'next-page',
      list_complete: false,
    })

    await expect(checking).resolves.toBe('stopped')
    expect(useAPIMock).toHaveBeenCalledTimes(2)
    expect(linkCheck.results.value).toHaveLength(1)
    expect(linkCheck.wasStopped.value).toBe(true)
  })

  it('can clear a stopped run and start again', async () => {
    useAPIMock
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({
        results: [{ slug: 'first', url: 'https://example.com/first', status: 200, ok: true, duration: 1, checkedAt: 'now' }],
        cursor: 'next-page',
        list_complete: false,
      })
      .mockResolvedValueOnce({
        results: [{ slug: 'first', url: 'https://example.com/first', status: 200, ok: true, duration: 1, checkedAt: 'later' }],
        cursor: 'next-page',
        list_complete: false,
      })
      .mockResolvedValueOnce({
        results: [{ slug: 'second', url: 'https://example.com/second', status: 200, ok: true, duration: 1, checkedAt: 'later' }],
        list_complete: true,
      })
    const linkCheck = useLinkCheck()
    await linkCheck.loadLinks()

    const firstRun = linkCheck.startCheck({ batchSize: 1, timeout: 6 })
    linkCheck.stopCheck()
    await expect(firstRun).resolves.toBe('stopped')
    linkCheck.clearResults()

    expect(linkCheck.results.value).toEqual([])
    expect(linkCheck.wasStopped.value).toBe(false)
    await expect(linkCheck.startCheck({ batchSize: 1, timeout: 6 })).resolves.toBe('completed')
    expect(linkCheck.results.value.map(result => result.slug)).toEqual(['first', 'second'])
  })

  it('returns empty when there are no links', async () => {
    useAPIMock.mockResolvedValue({ count: 0 })
    const linkCheck = useLinkCheck()

    await expect(linkCheck.startCheck({ batchSize: 6, timeout: 6 })).resolves.toBe('empty')
    expect(useAPIMock).toHaveBeenCalledOnce()
    expect(linkCheck.hasLinks.value).toBe(false)
  })
})
