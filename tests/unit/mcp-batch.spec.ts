import { describe, expect, it } from 'vitest'
import { isBatchRequest } from '../../server/services/mcp/batch'

const encoder = new TextEncoder()
const BYTE_ORDER_MARK = String.fromCharCode(0xFEFF)

function request(body: BodyInit | null, headers: Record<string, string> = { 'Content-Type': 'application/json' }) {
  return new Request('http://localhost/api/mcp', { method: 'POST', body, headers, duplex: 'half' } as RequestInit)
}

function chunked(...parts: (string | Uint8Array)[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts)
        controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part)
      controller.close()
    },
  })
}

// A check that never settles would hang every request, so each call races a
// short timer and the timer winning is a failure.
function settled<T>(promise: Promise<T>): Promise<T | 'never settled'> {
  return Promise.race([promise, new Promise<'never settled'>(resolve => setTimeout(resolve, 1000, 'never settled'))])
}

describe('isBatchRequest', () => {
  it.each([
    ['an array', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', true],
    ['an array after whitespace', ' \n\t\r[1]', true],
    ['an array after a byte order mark', `${BYTE_ORDER_MARK}[1]`, true],
    ['an object', '{"jsonrpc":"2.0","id":1,"method":"ping"}', false],
    ['an object that contains an array', '{"params":[1]}', false],
    ['a byte order mark that is not at the start', ` ${BYTE_ORDER_MARK}[1]`, false],
    ['an empty body', '', false],
    ['only whitespace', '   \n', false],
  ])('answers %s', async (_label, body, expected) => {
    expect(await settled(isBatchRequest(request(body)))).toBe(expected)
  })

  it.each([
    'application/json; charset=utf-8',
    'APPLICATION/JSON',
  ])('judges the content type %s', async (contentType) => {
    expect(await settled(isBatchRequest(request('[1]', { 'Content-Type': contentType })))).toBe(true)
  })

  it('does not judge a body that is not declared as JSON', async () => {
    expect(await settled(isBatchRequest(request('[1]', { 'Content-Type': 'text/plain' })))).toBe(false)
  })

  it('does not read a body declared larger than the 4 MiB limit', async () => {
    const headers = { 'Content-Type': 'application/json', 'Content-Length': String(4 * 1024 * 1024 + 1) }
    expect(await settled(isBatchRequest(request('[1]', headers)))).toBe(false)
  })

  it('settles for a body that arrives in several parts and leaves it readable', async () => {
    const original = request(chunked(' ', '[{"jsonrpc":"2.0",', '"id":1,"method":"ping"}]'))
    expect(await settled(isBatchRequest(original))).toBe(true)
    expect(await settled(original.text())).toBe(' [{"jsonrpc":"2.0","id":1,"method":"ping"}]')
  })

  it('recognises a byte order mark split across parts', async () => {
    const mark = encoder.encode(BYTE_ORDER_MARK)
    const original = request(chunked(mark.slice(0, 1), mark.slice(1), '[1]'))
    expect(await settled(isBatchRequest(original))).toBe(true)
  })

  it('answers false when the body cannot be read', async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('broken body'))
      },
    })
    expect(await settled(isBatchRequest(request(failing)))).toBe(false)
  })
})
