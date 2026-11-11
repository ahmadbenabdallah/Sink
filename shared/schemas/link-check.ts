import { z } from 'zod'
import { MAX_URL_LENGTH } from './link'

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  }
  catch {
    return false
  }
}

/** Accepted ranges for the link-check settings. The dashboard form shows the same numbers. */
export const LINK_CHECK_LIMITS = {
  timeout: { min: 1, max: 30 },
  batchSize: { min: 1, max: 10 },
} as const

export const LinkCheckTargetSchema = z.object({
  slug: z.string().trim().min(1).max(2048),
  url: z.string().trim().url().max(MAX_URL_LENGTH).refine(isHttpUrl, 'URL must use HTTP or HTTPS'),
})

export const LinkCheckRequestSchema = z.object({
  cursor: z.string().trim().max(1024).optional().describe('Pagination cursor from a previous response.'),
  limit: z.coerce.number().int().min(LINK_CHECK_LIMITS.batchSize.min).max(LINK_CHECK_LIMITS.batchSize.max).default(6).describe('Maximum number of links to check per page.'),
  timeout: z.coerce.number().int().min(LINK_CHECK_LIMITS.timeout.min).max(LINK_CHECK_LIMITS.timeout.max).default(6).describe('Timeout in seconds for each link check.'),
}).strict()

export const LinkCheckConfigSchema = z.object({
  timeout: z.coerce.number().int().min(LINK_CHECK_LIMITS.timeout.min).max(LINK_CHECK_LIMITS.timeout.max).default(6),
  batchSize: z.coerce.number().int().min(LINK_CHECK_LIMITS.batchSize.min).max(LINK_CHECK_LIMITS.batchSize.max).default(6),
})

export type LinkCheckTarget = z.infer<typeof LinkCheckTargetSchema>
export type LinkCheckRequest = z.infer<typeof LinkCheckRequestSchema>
export type LinkCheckConfig = z.infer<typeof LinkCheckConfigSchema>
export type LinkCheckConfigInput = z.input<typeof LinkCheckConfigSchema>
