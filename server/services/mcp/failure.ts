const MAX_TEXT_LENGTH = 300

export interface FailureDescription {
  errorName: string
  /** The error's own message. Left out when the error wraps another one. */
  message?: string
  /** The message of the underlying cause, when there is one. */
  cause?: string
}

/**
 * What may be logged about something that was thrown: enough to diagnose it,
 * without anything the caller sent.
 *
 * An error that wraps another is described by its cause alone. The database
 * driver is why: it wraps a failed query in an error whose message is the
 * statement and its parameters, which can hold a token hash or a link target,
 * and puts what actually went wrong in the cause ("no such table", for a
 * deployment that has not run its migration). Leaving the wrapper's message
 * out for every wrapped error, not only the driver's, means a wrapper this
 * code has never seen cannot leak either.
 *
 * An error with no cause is described by its name and message.
 */
export function describeFailure(error: unknown): FailureDescription {
  if (!(error instanceof Error))
    return { errorName: typeof error }

  const cause = (error.cause as { message?: unknown } | undefined)?.message
  if (typeof cause === 'string')
    return { errorName: error.name, cause: cause.slice(0, MAX_TEXT_LENGTH) }

  // The driver's query error always carries the statement, cause or not.
  if ('query' in error)
    return { errorName: error.name }

  return { errorName: error.name, message: error.message.slice(0, MAX_TEXT_LENGTH) }
}
