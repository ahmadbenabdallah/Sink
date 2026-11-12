const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024
const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0A, 0x0D])
const BYTE_ORDER_MARK = [0xEF, 0xBB, 0xBF]
const OPENING_BRACKET = 0x5B

/**
 * Whether the body is a JSON array, which is how JSON-RPC spells a batch.
 *
 * Only the first byte that is not whitespace or a leading byte order mark is
 * looked at, on a clone, so the body is never parsed here and the original
 * request reaches the SDK unread. Two cases are not judged at all, because the
 * SDK answers them from the headers without reading the body: a content type
 * that is not JSON (415) and a declared length over its 4 MiB limit (413).
 */
export async function isBatchRequest(request: Request): Promise<boolean> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('json'))
    return false
  if (Number(request.headers.get('content-length')) > MAX_REQUEST_BODY_BYTES)
    return false

  try {
    const reader = request.clone().body?.getReader()
    if (!reader)
      return false

    let position = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done)
        return false
      for (const byte of value) {
        // A byte order mark counts only as the first three bytes of the body.
        const skip = JSON_WHITESPACE.has(byte) || byte === BYTE_ORDER_MARK[position]
        position++
        if (skip)
          continue
        // Not awaited: the clone shares its source with the original request,
        // and cancelling one side only settles once the other side is read.
        void reader.cancel().catch(() => {})
        return byte === OPENING_BRACKET
      }
    }
  }
  catch {
    return false
  }
}
