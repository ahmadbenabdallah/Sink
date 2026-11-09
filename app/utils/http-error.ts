/** HTTP status of a failed $fetch/useAPI call; undefined for network errors and non-HTTP failures. */
export function getHttpErrorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number')
    return error.status
  return undefined
}
