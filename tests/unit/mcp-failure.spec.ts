import { describe, expect, it } from 'vitest'
import { describeFailure } from '../../server/services/mcp/failure'

describe('describeFailure', () => {
  it('describes an ordinary error by its name and message', () => {
    expect(describeFailure(new TypeError('Cannot read properties of undefined'))).toEqual({
      errorName: 'TypeError',
      message: 'Cannot read properties of undefined',
    })
  })

  // The database driver wraps a failure in an error whose message is the query
  // and its parameters, which can hold a token hash or a link target. What
  // went wrong is in the cause.
  it('describes a failed query by its cause, never by the query', () => {
    const failure = Object.assign(new Error('Failed query: select * from mcp_tokens where token_hash = ? params: abc123'), {
      query: 'select * from mcp_tokens where token_hash = ?',
      params: ['abc123'],
      cause: new Error('D1_ERROR: no such table: mcp_tokens'),
    })

    const described = describeFailure(failure)
    expect(described).toEqual({ errorName: 'Error', cause: 'D1_ERROR: no such table: mcp_tokens' })
    expect(JSON.stringify(described)).not.toContain('abc123')
  })

  // Any error that wraps another is described by the cause alone, so a
  // wrapper this code has never seen cannot leak through its message either.
  it('describes an error that wraps another by the cause, not by its own message', () => {
    const wrapped = new Error('request to https://example.com/?token=secret failed', { cause: new Error('connection reset') })
    expect(describeFailure(wrapped)).toEqual({ errorName: 'Error', cause: 'connection reset' })
  })

  it('never describes a failed query by its message, even without a cause', () => {
    const failure = Object.assign(new Error('Failed query: select 1 params: secret'), { query: 'select 1', params: ['secret'] })
    expect(describeFailure(failure)).toEqual({ errorName: 'Error' })
  })

  it('keeps long texts short', () => {
    expect(describeFailure(new Error('x'.repeat(1000))).message).toHaveLength(300)
    expect(describeFailure(new Error('wrapper', { cause: new Error('y'.repeat(1000)) })).cause).toHaveLength(300)
  })

  it.each([
    ['a string', 'boom', { errorName: 'string' }],
    ['nothing', undefined, { errorName: 'undefined' }],
    ['null', null, { errorName: 'object' }],
  ])('describes %s that was thrown by its type', (_label, thrown, expected) => {
    expect(describeFailure(thrown)).toEqual(expected)
  })
})
