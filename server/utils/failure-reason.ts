import { isError } from 'h3'

/**
 * Reason safe to return to a client for a failed item. Errors the server raised
 * on purpose (`createError`) keep their text; anything else, such as a database
 * driver error carrying SQL, is logged and replaced by `fallback`.
 */
export function publicFailureReason(error: unknown, fallback: string, context: Record<string, unknown>): string {
  if (isError(error) && error.statusCode < 500 && error.statusMessage)
    return error.statusMessage
  // Never the error's own message: a query error's message lists the bound parameters (URLs, password
  // hashes). Its `cause` is the database's reason (e.g. a constraint name), which carries no row data.
  const { name, cause } = (error ?? {}) as { name?: unknown, cause?: { message?: unknown } }
  console.error({
    event: 'link_write.failed',
    ...context,
    errorName: typeof name === 'string' ? name : typeof error,
    cause: typeof cause?.message === 'string' ? cause.message.slice(0, 300) : undefined,
  })
  return fallback
}
