import { describe, expect, it } from 'vitest'
import { getHttpErrorStatus } from '../../app/utils/http-error'

describe('getHttpErrorStatus', () => {
  it('reads the status of a $fetch error', () => {
    expect(getHttpErrorStatus(Object.assign(new Error('Not Found'), { status: 404, statusCode: 404 }))).toBe(404)
  })

  it('returns undefined for a network error without a status', () => {
    expect(getHttpErrorStatus(new TypeError('Failed to fetch'))).toBeUndefined()
  })

  it('ignores non-numeric status values', () => {
    expect(getHttpErrorStatus({ status: '404' })).toBeUndefined()
  })

  it('returns undefined for non-object errors', () => {
    expect(getHttpErrorStatus('boom')).toBeUndefined()
    expect(getHttpErrorStatus(null)).toBeUndefined()
  })
})
