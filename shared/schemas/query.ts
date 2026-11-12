import { z } from 'zod'

const listQueryLimit = +useRuntimeConfig().listQueryLimit

/** The access-log filters every analytics query shares. */
export const FilterQuerySchema = z.object({
  id: z.string().optional().describe('Link ID (the `id` of a link, not its slug).'),
  startAt: z.coerce.number().int().safe().optional().describe('Start of the window, unix seconds. When startAt and endAt are both omitted there is no time bound and all retained data is included.'),
  endAt: z.coerce.number().int().safe().optional().describe('End of the window, unix seconds.'),
  url: z.string().optional().describe('Target URL of the link.'),
  slug: z.string().optional().describe('Link slug.'),
  referer: z.string().optional().describe('Referring hostname.'),
  country: z.string().optional().describe('Visitor country code.'),
  region: z.string().optional().describe('Visitor region.'),
  city: z.string().optional().describe('Visitor city.'),
  timezone: z.string().optional().describe('Visitor IANA timezone.'),
  language: z.string().optional().describe('Visitor language.'),
  os: z.string().optional().describe('Operating system.'),
  browser: z.string().optional().describe('Browser name.'),
  browserType: z.string().optional().describe('Browser category.'),
  device: z.string().optional().describe('Device model.'),
  deviceType: z.string().optional().describe('Device category.'),
})

/** The filters plus a row limit for queries that actually paginate. */
export const QuerySchema = FilterQuerySchema.extend({
  limit: z.coerce.number().int().safe().min(1).max(listQueryLimit).default(listQueryLimit).describe('Maximum number of rows.'),
})

export type FilterQuery = z.infer<typeof FilterQuerySchema>
export type Query = z.infer<typeof QuerySchema>
