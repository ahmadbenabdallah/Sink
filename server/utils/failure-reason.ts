import { isError } from 'h3'

/**
 * Reason safe to return to a client for a failed item. Errors the server raised
 * on purpose (`createError`) keep their text; anything else, such as a database
 * driver error carrying SQL, is logged and replaced by `fallback`.
 */
export function publicFailureReason(error: unknown, fallback: string, context: Record<string, unknown>): string {
  if (isError(error) && error.statusCode < 500 && error.statusMessage)
    return error.statusMessage
  // A bounded string, not the object: a driver error can carry query parameters (URLs, password hashes).
  const cause = (error as { cause?: { message?: unknown } } | null)?.cause?.message
  const message = String(cause ?? (error as { message?: unknown } | null)?.message ?? error).slice(0, 300)
  console.error({ event: 'link_write.failed', ...context, error: message })
  return fallback
}
