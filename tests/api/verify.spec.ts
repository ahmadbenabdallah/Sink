import type { VerifyResponse } from '../../shared/types/auth'
import { describe, expect, it } from 'vitest'
import { fetch, fetchWithAuth } from '../utils'

describe('/api rate limit', () => {
  // The limiter sits in front of the token check on every /api/ route and
  // counts per client address, so it is exercised on the cheapest route with
  // an address no other test uses. The window resets on minute boundaries;
  // `retry` covers a run that starts just before one.
  it('refuses a client address after 1200 requests in a minute, whatever the token', { retry: 1, timeout: 60000 }, async () => {
    const limited = `198.51.100.${1 + Math.floor(Math.random() * 250)}`
    const request = () => fetch('/api/verify', { headers: { 'cf-connecting-ip': limited } })

    for (let sent = 0; sent < 1200; sent += 50) {
      const statuses = await Promise.all(Array.from({ length: 50 }, async () => (await request()).status))
      expect(new Set(statuses)).toEqual(new Set([401]))
    }

    const refused = await request()
    expect(refused.status).toBe(429)
    expect(refused.headers.get('Retry-After')).toBe('60')
    expect(await refused.json()).toMatchObject({ statusMessage: 'Too many requests', data: { code: 'too_many_requests' } })

    const withToken = await fetchWithAuth('/api/verify', { headers: { 'cf-connecting-ip': limited } })
    expect(withToken.status).toBe(429)

    const otherClient = await fetchWithAuth('/api/verify', { headers: { 'cf-connecting-ip': '198.51.100.254' } })
    expect(otherClient.status).toBe(200)

    // Only /api/ is limited: the refused address still reaches other routes.
    const outsideApi = await fetch('/', { headers: { 'cf-connecting-ip': limited } })
    expect(outsideApi.status).not.toBe(429)
  })
})

describe('/api/verify', () => {
  it('returns the expected verification data with valid auth', async () => {
    const response = await fetchWithAuth('/api/verify')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('application/json')

    const data = await response.json() as VerifyResponse
    expect(data).toMatchObject({
      name: 'Sink',
      url: 'https://sink.cool',
      authMethod: 'site-token',
      userID: 'root',
      userEmail: 'root@localhost',
      accessEnabled: false,
    })
  })

  it('returns 401 when accessing without auth', async () => {
    const response = await fetch('/api/verify')
    expect(response.status).toBe(401)
  })

  it('returns 401 with invalid token', async () => {
    const response = await fetch('/api/verify', {
      headers: { Authorization: 'Bearer invalid-token-12345' },
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ statusMessage: 'Unauthorized' })
  })

  it('does not trust an Access header when Access is not configured', async () => {
    const response = await fetch('/api/verify', {
      headers: { 'Cf-Access-Jwt-Assertion': 'unsigned-token' },
    })
    expect(response.status).toBe(401)
  })

  it('does not trust an Access cookie when Access is not configured', async () => {
    const response = await fetch('/api/verify', {
      headers: { Cookie: 'CF_Authorization=unsigned-token' },
    })
    expect(response.status).toBe(401)
  })
})
