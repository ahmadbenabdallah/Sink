/** HTTP status of a failed $fetch/useAPI call; undefined for network errors and non-HTTP failures. */
export function getHttpErrorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number')
    return error.status
  return undefined
}

const MAX_REASON_LENGTH = 200
// h3 defaults that say nothing a translated fallback does not say better.
const GENERIC_REASONS = new Set(['Server Error', 'Internal Server Error', 'Validation Error'])

function plainReason(value: unknown): string | undefined {
  if (typeof value !== 'string')
    return undefined

  const text = value.trim()
  // A leading bracket or brace is ofetch transport text (`[POST] "/api/x": 409 …`) or a zod issue dump.
  if (!text || text.length > MAX_REASON_LENGTH || /^[[{]|\n/.test(text) || GENERIC_REASONS.has(text))
    return undefined
  return text
}

function parseErrorBody(data: unknown): { statusMessage?: unknown, message?: unknown } {
  // `responseType: 'text'` requests receive the JSON error body unparsed.
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    }
    catch {}
  }
  return typeof data === 'object' && data !== null ? data : {}
}

/** The app's own reason (a zod `custom` issue such as "slug is reserved") from an h3 validation failure. */
function validationReason(message: unknown): string | undefined {
  if (typeof message !== 'string')
    return undefined
  try {
    const issues: unknown = JSON.parse(message)
    if (Array.isArray(issues))
      return plainReason(issues.find(issue => issue?.code === 'custom')?.message)
  }
  catch {}
  return undefined
}

/**
 * Message to show for a failed $fetch/useAPI call: the server's own reason when it is a
 * short plain string, otherwise the caller's translated `fallback`.
 */
export function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error !== 'object' || error === null)
    return fallback

  const { data, statusMessage } = error as { data?: unknown, statusMessage?: unknown }
  const body = parseErrorBody(data)
  if (body.statusMessage === 'Validation Error')
    return validationReason(body.message) ?? fallback
  return plainReason(body.statusMessage) ?? plainReason(body.message) ?? plainReason(statusMessage) ?? fallback
}
