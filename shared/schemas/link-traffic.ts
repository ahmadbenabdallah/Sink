import { z } from 'zod'

/** The Links page's traffic sorts: by the three numbers each link card shows. */
export const TRAFFIC_SORTS = ['visits', 'visitors', 'referers'] as const
export type TrafficSort = (typeof TRAFFIC_SORTS)[number]

/**
 * GET /api/link/traffic. The tag and status rules match the list's; they are
 * repeated here because `shared/schemas/link.ts` needs Nuxt's runtime config
 * to load, and this schema is also used outside Nuxt.
 */
export const TrafficLinksQuerySchema = z.object({
  sort: z.enum(TRAFFIC_SORTS),
  tag: z.string().trim().toLowerCase().min(1).max(32).optional(),
  status: z.enum(['active', 'expired', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().trim().max(1024).optional(),
})

export type TrafficLinksQuery = z.infer<typeof TrafficLinksQuerySchema>
