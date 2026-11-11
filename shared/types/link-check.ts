import type { LinkCheckConfig, LinkCheckConfigInput, LinkCheckRequest, LinkCheckTarget } from '#shared/schemas/link-check'

export type { LinkCheckConfig, LinkCheckConfigInput, LinkCheckRequest, LinkCheckTarget }

/** Why a check got no HTTP response; translated on the dashboard as `check.errors.<code>`. */
export const LINK_CHECK_ERROR_CODES = ['timeout', 'blocked', 'too_many_redirects', 'network'] as const

export type LinkCheckErrorCode = (typeof LINK_CHECK_ERROR_CODES)[number]

export interface LinkCheckResult extends LinkCheckTarget {
  status: number
  ok: boolean
  duration: number
  checkedAt: string
  errorCode?: LinkCheckErrorCode
}

export interface LinkCheckResponse {
  results: LinkCheckResult[]
  cursor?: string
  list_complete: boolean
}
