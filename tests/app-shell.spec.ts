import { describe, expect, it } from 'vitest'
import { fetch } from './utils'

describe('app shell resource hints', () => {
  // Cloudflare refuses `Sec-Purpose: prefetch` requests to Worker routes with a
  // 503, so <link rel="prefetch"> hints only add failed requests and console noise.
  it('emits no prefetch hints but keeps the entry modulepreload', async () => {
    const response = await fetch('/dashboard/links')
    const html = await response.text()

    expect(response.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('rel="modulepreload"')
    expect(html).not.toContain('rel="prefetch"')
  })
})
