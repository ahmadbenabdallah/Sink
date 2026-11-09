import { describe, expect, it } from 'vitest'
import { getCanonicalUrl } from '../../app/utils/canonical'

describe('getCanonicalUrl', () => {
  it('uses the configured site URL instead of the current origin', () => {
    expect(getCanonicalUrl('/dashboard/links', 'https://go.example.com', 'http://localhost:7465'))
      .toBe('https://go.example.com/dashboard/links')
  })

  it('does not double the slash when the configured URL ends with one', () => {
    expect(getCanonicalUrl('/', 'https://go.example.com/', 'http://localhost:7465'))
      .toBe('https://go.example.com/')
  })

  it('falls back to the current origin when no site URL is configured', () => {
    expect(getCanonicalUrl('/dashboard', '', 'https://links.acme.test'))
      .toBe('https://links.acme.test/dashboard')
  })

  it('treats a blank site URL as not configured', () => {
    expect(getCanonicalUrl('/', '   ', 'https://links.acme.test'))
      .toBe('https://links.acme.test/')
  })
})
