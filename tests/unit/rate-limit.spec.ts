import { afterEach, describe, expect, it, vi } from 'vitest'
import { allowAttempt, clientBucket } from '../../server/utils/rate-limit'

function fakeLimiter(success: boolean) {
  return { limit: vi.fn(async (_options: { key: string }) => ({ success })) }
}

describe('allowAttempt', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('counts the attempt under the given key and allows what the limiter accepts', async () => {
    const limiter = fakeLimiter(true)

    expect(await allowAttempt(limiter, '203.0.113.7', 'test.allowed')).toBe(true)
    expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({ key: '203.0.113.7' })
  })

  it('refuses what the limiter refuses', async () => {
    expect(await allowAttempt(fakeLimiter(false), '203.0.113.7', 'test.refused')).toBe(false)
  })

  // An environment without the binding (a Pages deployment, local dev) calls
  // this on every request, so the warning is logged once and not per request.
  it('allows every attempt when the binding is missing and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The "already warned" state lives in the module, which the whole run
    // shares, so the event name is unique to this attempt.
    const event = `test.missing.${crypto.randomUUID()}`

    expect(await allowAttempt(undefined, '203.0.113.7', event)).toBe(true)
    expect(await allowAttempt(undefined, '203.0.113.8', event)).toBe(true)

    expect(warn).toHaveBeenCalledExactlyOnceWith({ event, reason: 'binding missing' })
  })

  it('allows the attempt and warns when the limiter throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const limiter = {
      async limit(): Promise<{ success: boolean }> {
        throw new Error('limiter down')
      },
    }

    expect(await allowAttempt(limiter, '203.0.113.7', 'test.throwing')).toBe(true)
    expect(warn).toHaveBeenCalledExactlyOnceWith({ event: 'test.throwing', reason: 'limit call failed' })
  })
})

describe('clientBucket', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2'],
    ['2001:DB8:1:2::9', '2001:db8:1:2'],
    ['::1', '0:0:0:0'],
    ['::ffff:203.0.113.7', '::ffff:203.0.113.7'],
    [undefined, 'unknown'],
    ['', 'unknown'],
  ])('puts %j in the bucket %s', (ip, bucket) => {
    expect(clientBucket(ip)).toBe(bucket)
  })
})
