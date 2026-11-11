import { describe, expect, it } from 'vitest'
import { getLoginFailureReason } from '../../app/utils/login-failure'

const messages = { invalidToken: 'Invalid token', fallback: 'Unexpected error' }

describe('getLoginFailureReason', () => {
  it('reports an invalid token for 401, ignoring the server text', () => {
    expect(getLoginFailureReason({ status: 401, data: { statusMessage: 'Unauthorized' } }, messages)).toBe('Invalid token')
  })

  it('shows the server reason for other HTTP failures', () => {
    expect(getLoginFailureReason({ status: 403, data: { statusMessage: 'Access denied for this identity' } }, messages))
      .toBe('Access denied for this identity')
  })

  it('falls back when there is no usable server reason', () => {
    expect(getLoginFailureReason({ status: 500, data: { statusMessage: 'Internal Server Error' } }, messages)).toBe('Unexpected error')
    expect(getLoginFailureReason(new TypeError('Failed to fetch'), messages)).toBe('Unexpected error')
    expect(getLoginFailureReason(undefined, messages)).toBe('Unexpected error')
  })
})
