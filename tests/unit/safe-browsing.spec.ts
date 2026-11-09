import type { H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ofetchMock = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({ ofetch: ofetchMock }))

const { isSafeUrl } = await import('../../server/utils/safe-browsing')

const event = {} as H3Event

afterEach(() => {
  vi.unstubAllGlobals()
  ofetchMock.mockReset()
})

describe('isSafeUrl', () => {
  it('flags a host the DoH resolver sinkholes to 0.0.0.0', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ safeBrowsingDoh: 'https://doh.test/dns-query' }))
    ofetchMock.mockResolvedValue({ Answer: [{ data: '0.0.0.0' }] })

    await expect(isSafeUrl(event, 'https://bad.example/')).resolves.toBe(false)
  })

  // Deliberate: a DoH outage must not put a warning page in front of every new link.
  it('fails open when the DoH lookup errors', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ safeBrowsingDoh: 'https://doh.test/dns-query' }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    ofetchMock.mockRejectedValue(new Error('timeout'))

    await expect(isSafeUrl(event, 'https://any.example/')).resolves.toBe(true)
  })
})
