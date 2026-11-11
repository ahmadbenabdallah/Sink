import { getErrorMessage, getHttpErrorStatus } from './http-error'

/** Reason shown under "login failed": a rejected token (401) gets its own message, anything else the server's reason. */
export function getLoginFailureReason(error: unknown, messages: { invalidToken: string, fallback: string }): string {
  return getHttpErrorStatus(error) === 401
    ? messages.invalidToken
    : getErrorMessage(error, messages.fallback)
}
