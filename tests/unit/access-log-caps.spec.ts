import type { H3Event } from 'h3'
import { getHeader } from 'h3'
import { describe, expect, it, vi } from 'vitest'
import { collectAccessLog, MAX_USER_AGENT_BYTES, truncateUtf8 } from '../../server/utils/access-log'

vi.mock('#shared/utils/flag', () => ({ getFlag: vi.fn(() => '') }))
// Nitro auto-imports these at build time.
vi.stubGlobal('getHeader', getHeader)
const runtimeConfig = { disableBotAccessLog: false }
vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)

const bytes = (value: string) => new TextEncoder().encode(value).length

function clickEvent(userAgent: string, headers: Record<string, string> = {}): H3Event {
  return {
    node: { req: { headers: { 'user-agent': userAgent, 'cf-connecting-ip': '203.0.113.7', ...headers } } },
    context: { cloudflare: { request: { cf: {} } }, link: { slug: 'abc', url: 'https://example.com' } },
  } as unknown as H3Event
}

describe('collectAccessLog user agent', () => {
  it('stores the first 512 bytes of a padded header and still reads browser and OS', () => {
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    const padded = `${chrome} ${'x'.repeat(16_000)}`

    const { logs } = collectAccessLog(clickEvent(padded))!

    expect(MAX_USER_AGENT_BYTES).toBe(512)
    expect(logs.ua).toBe(padded.slice(0, 512))
    expect(logs).toMatchObject({ browser: 'Chrome', os: 'Windows' })
  })

  it('keeps an ordinary user agent unchanged', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    expect(collectAccessLog(clickEvent(ua))!.logs.ua).toBe(ua)
  })

  it('caps the user agent in the log line written when bot clicks are not recorded', () => {
    const bot = `Googlebot/2.1 (+http://www.google.com/bot.html) ${'x'.repeat(16_000)}`
    runtimeConfig.disableBotAccessLog = true
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(collectAccessLog(clickEvent(bot))).toBeUndefined()
      expect(log).toHaveBeenCalledWith('bot access log disabled:', bot.slice(0, 512))
    }
    finally {
      runtimeConfig.disableBotAccessLog = false
      log.mockRestore()
    }
  })
})

// Every visitor-controlled text field is capped, or the padding just moves to another header.
describe('collectAccessLog referer and language', () => {
  it('stores at most 255 bytes of the referer host, the longest a DNS name can be', () => {
    const host = `${'a'.repeat(15_000)}.example`

    const { logs, click } = collectAccessLog(clickEvent('test', { referer: `https://${host}/page` }))!

    expect(logs.referer).toBe(host.slice(0, 255))
    expect(click.referer).toBe(host.slice(0, 255))
  })

  it('stores at most 64 bytes of the language tag', () => {
    const { logs } = collectAccessLog(clickEvent('test', { 'accept-language': `${'x'.repeat(15_000)},en;q=0.5` }))!

    expect(logs.language).toBe('x'.repeat(64))
  })

  it('keeps ordinary values unchanged, and a missing referer missing', () => {
    expect(collectAccessLog(clickEvent('test', { 'referer': 'https://news.example.com/a', 'accept-language': 'fr-CA,fr;q=0.9' }))!.logs)
      .toMatchObject({ referer: 'news.example.com', language: 'fr-CA' })
    expect(collectAccessLog(clickEvent('test'))!.logs).toMatchObject({ referer: undefined, language: undefined })
  })
})

describe('truncateUtf8', () => {
  it('returns a value within the limit unchanged', () => {
    expect(truncateUtf8('abc', 3)).toBe('abc')
    expect(truncateUtf8('', 3)).toBe('')
    expect(truncateUtf8('é'.repeat(256), 512)).toBe('é'.repeat(256))
  })

  it('returns an empty string for a limit of 0', () => {
    expect(truncateUtf8('abc', 0)).toBe('')
  })

  it('cuts to the limit in bytes without splitting a character', () => {
    expect(truncateUtf8('abcdef', 4)).toBe('abcd')
    // 1 + 2 × 300 bytes: the last whole character ends at byte 511.
    const accented = truncateUtf8(`a${'é'.repeat(300)}`, 512)
    expect(bytes(accented)).toBe(511)
    expect(accented).toBe(`a${'é'.repeat(255)}`)
    expect(truncateUtf8('ab😀', 5)).toBe('ab')
  })
})
