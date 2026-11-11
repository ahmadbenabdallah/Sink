import { createError } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publicFailureReason } from '../../server/utils/failure-reason'
import { normalizeLinkPasswordForStorage } from '../../server/utils/link-password'
import { maskLinkPassword } from '../../shared/utils/link-password'

vi.mock('#shared/utils/link-password', async () => import('../../shared/utils/link-password'))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('publicFailureReason', () => {
  it('keeps the reason of an error the server raised on purpose', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(publicFailureReason(createError({ status: 400, statusText: 'Slug already exists' }), 'Failed to save link', {})).toBe('Slug already exists')
    expect(log).not.toHaveBeenCalled()
  })

  it.each([
    ['a driver error', new Error('Failed query: insert into "links" ("slug") values (?) params: secret')],
    ['a non-error value', 'D1_ERROR: no such table: links'],
  ])('replaces %s with the fallback and logs the real one', (_name, error) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(publicFailureReason(error, 'Failed to save link', { slug: 'abc' })).toBe('Failed to save link')
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'link_write.failed', slug: 'abc' }))
  })

  it('does not keep the text of a server-side (5xx) error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(publicFailureReason(createError({ status: 500, statusText: 'D1_ERROR: no such table' }), 'Failed to save link', {})).toBe('Failed to save link')
  })

  it('logs the database cause, bounded, and never the query message with its parameters', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('Failed query: insert into "links" values (?) params: pbkdf2-hash-secret', {
      cause: new Error(`D1_ERROR: UNIQUE constraint failed ${'x'.repeat(1000)}`),
    })

    publicFailureReason(error, 'Failed to save link', {})

    const logged = log.mock.calls[0]![0] as { errorName: string, cause: string }
    expect(logged.errorName).toBe('Error')
    expect(logged.cause).toMatch(/^D1_ERROR: UNIQUE constraint failed/)
    expect(logged.cause.length).toBeLessThanOrEqual(300)
    expect(JSON.stringify(logged)).not.toContain('pbkdf2-hash-secret')
  })

  // A 4xx createError, so publicFailureReason keeps its text (first test above).
  it('a masked password is rejected with a client error that carries a plain reason', async () => {
    await expect(normalizeLinkPasswordForStorage(maskLinkPassword('secret123')))
      .rejects
      .toMatchObject({ statusCode: 400, statusMessage: 'Masked password cannot be stored' })
  })
})
