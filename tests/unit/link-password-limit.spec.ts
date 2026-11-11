import { afterEach, describe, expect, it, vi } from 'vitest'
import { allowLinkPasswordAttempt } from '../../server/utils/link-password-limit'

function fakeLimiter(success: boolean) {
  return { limit: vi.fn(async (_options: { key: string }) => ({ success })) }
}

describe('allowLinkPasswordAttempt', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('allows an attempt the limiter accepts, keyed by slug and client IP', async () => {
    const limiter = fakeLimiter(true)

    expect(await allowLinkPasswordAttempt(limiter, 'my-link', '203.0.113.7')).toBe(true)
    expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({ key: 'my-link:203.0.113.7' })
  })

  // One IPv6 host usually controls a whole /64, so rotating inside it must not give a fresh bucket.
  it.each([
    ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2'],
    ['2001:db8:1:2::1', '2001:db8:1:2'],
    ['2001:db8::1', '2001:db8:0:0'],
    ['2001:DB8:1:2::9', '2001:db8:1:2'],
    ['::1', '0:0:0:0'],
  ])('keys the IPv6 address %s by its /64 prefix', async (ip, prefix) => {
    const limiter = fakeLimiter(true)

    await allowLinkPasswordAttempt(limiter, 'my-link', ip)

    expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({ key: `my-link:${prefix}` })
  })

  it('rejects an attempt the limiter refuses', async () => {
    expect(await allowLinkPasswordAttempt(fakeLimiter(false), 'my-link', '203.0.113.7')).toBe(false)
  })

  it('fails open with a warning when the binding is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await allowLinkPasswordAttempt(undefined, 'my-link', '203.0.113.7')).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('fails open with a warning when the limiter throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const limiter = {
      async limit(): Promise<{ success: boolean }> {
        throw new Error('limiter down')
      },
    }

    expect(await allowLinkPasswordAttempt(limiter, 'my-link', '203.0.113.7')).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, ''])('puts clients without an IP (%j) in one shared bucket per slug', async (ip) => {
    const limiter = fakeLimiter(true)

    await allowLinkPasswordAttempt(limiter, 'my-link', ip)
    expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({ key: 'my-link:unknown' })
  })
})
