import { describe, expect, it } from 'vitest'
import { getErrorMessage, getHttpErrorStatus } from '../../app/utils/http-error'

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

describe('getErrorMessage', () => {
  const fallback = 'Something went wrong'
  // Shape of an ofetch FetchError: transport text in `message`, the server body in `data`.
  function fetchError(data: unknown, statusMessage = '') {
    return Object.assign(new Error('[POST] "/api/link/create": 409 Link already exists'), { status: 409, statusMessage, data })
  }

  it('prefers the server reason over the transport text', () => {
    expect(getErrorMessage(fetchError({ statusMessage: 'Link already exists', message: 'Link already exists' }), fallback))
      .toBe('Link already exists')
    expect(getErrorMessage(fetchError({ message: 'Link not found' }), fallback)).toBe('Link not found')
    expect(getErrorMessage(fetchError(undefined, 'Too Many Requests'), fallback)).toBe('Too Many Requests')
  })

  it('reads a JSON error body that arrived as text', () => {
    expect(getErrorMessage(fetchError('{"statusMessage":"Not Found"}'), fallback)).toBe('Not Found')
    expect(getErrorMessage(fetchError('<html>502</html>'), fallback)).toBe(fallback)
  })

  it('never returns the transport string', () => {
    expect(getErrorMessage(fetchError(undefined), fallback)).toBe(fallback)
    expect(getErrorMessage(fetchError({ message: '[GET] "/api/x": 500 Server Error' }), fallback)).toBe(fallback)
    expect(getErrorMessage(new TypeError('Failed to fetch'), fallback)).toBe(fallback)
  })

  it('never returns raw zod issue JSON', () => {
    const issues = JSON.stringify([{ code: 'invalid_format', path: ['slug'], message: 'Invalid string: must match pattern /^[a-z0-9]+$/' }], null, 2)
    expect(getErrorMessage(fetchError({ message: issues }), fallback)).toBe(fallback)
    expect(getErrorMessage(fetchError({ statusMessage: 'Validation Error', message: issues }), fallback)).toBe(fallback)
  })

  it('shows the app-written reason of a server validation failure', () => {
    const issues = JSON.stringify([
      { code: 'invalid_format', path: ['url'], message: 'Invalid URL' },
      { code: 'custom', path: ['slug'], message: 'slug is reserved' },
    ], null, 2)
    expect(getErrorMessage(fetchError({ statusMessage: 'Validation Error', message: issues }), fallback)).toBe('slug is reserved')
    expect(getErrorMessage(fetchError({ statusMessage: 'Validation Error', message: 'not json' }), fallback)).toBe(fallback)
  })

  it('falls back for generic, empty, long, multi-line and non-string reasons', () => {
    expect(getErrorMessage(fetchError({ statusMessage: 'Server Error' }), fallback)).toBe(fallback)
    expect(getErrorMessage(fetchError({ statusMessage: '  ' }), fallback)).toBe(fallback)
    expect(getErrorMessage(fetchError({ statusMessage: 'x'.repeat(201) }), fallback)).toBe(fallback)
    expect(getErrorMessage(fetchError({ statusMessage: 'line one\nline two' }), fallback)).toBe(fallback)
    expect(getErrorMessage(fetchError({ statusMessage: 42 }), fallback)).toBe(fallback)
    expect(getErrorMessage('boom', fallback)).toBe(fallback)
    expect(getErrorMessage(null, fallback)).toBe(fallback)
  })
})
