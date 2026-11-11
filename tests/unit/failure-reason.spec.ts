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
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ slug: 'abc', error: expect.any(String) }))
  })

  it('does not keep the text of a server-side (5xx) error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(publicFailureReason(createError({ status: 500, statusText: 'D1_ERROR: no such table' }), 'Failed to save link', {})).toBe('Failed to save link')
  })

  it('logs a bounded message, never the whole error object', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    publicFailureReason(new Error(`Failed query params: ${'x'.repeat(1000)}`), 'Failed to save link', {})

    const logged = log.mock.calls[0]![0] as { error: string }
    expect(logged.error.length).toBeLessThanOrEqual(300)
  })

  it('keeps the masked-password reason raised while preparing a link', async () => {
    const error = await normalizeLinkPasswordForStorage(maskLinkPassword('secret123')).catch(error => error)

    expect(publicFailureReason(error, 'Failed to save link', {})).toBe('Masked password cannot be stored')
  })
})
