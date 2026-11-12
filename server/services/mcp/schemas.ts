import type { MetricType } from '../../utils/analytics-queries'
import { z } from 'zod'
import {
  CreateLinkSchema,
  DeleteLinkSchema,
  EditLinkSchema,
  LinkFilterQuerySchema,
  LinkSlugQuerySchema,
  ListLinksQuerySchema,
  NewSlugSchema,
  SearchLinksQuerySchema,
} from '#shared/schemas/link'
import { LinkCheckRequestSchema } from '#shared/schemas/link-check'
import { FilterQuerySchema } from '#shared/schemas/query'
import {
  HeatmapQuerySchema,
  isOrderedRange,
  MetricsQuerySchema,
  ORDERED_RANGE_ISSUE,
  ViewsQuerySchema,
} from '../../utils/analytics-queries'

/**
 * The input contracts the MCP tools advertise and validate against. Each one is
 * derived from the schema the matching REST route uses, then tightened for a
 * caller that is a model:
 *
 * - strict, so a misspelled argument is an error the model can read instead of
 *   a silently ignored key;
 * - no server-generated fields, so the advertised tool list is identical on
 *   every request and a caller cannot choose a link's id or timestamps;
 * - smaller pages.
 *
 * REST and the dashboard keep using the shared schemas, whose behaviour is
 * unchanged.
 */

// The shared limits allow 500 to 1000 rows, and every MCP result is sent as
// both text and structured content.
const McpPageLimitSchema = z.coerce.number().int().min(1).max(100).default(20).describe('Maximum number of results, 1-100.')

export const McpListLinksSchema = ListLinksQuerySchema.extend({ limit: McpPageLimitSchema }).strict()
export const McpSearchLinksSchema = SearchLinksQuerySchema.extend({ limit: McpPageLimitSchema }).strict()
export const McpGetLinkSchema = LinkSlugQuerySchema.strict()
export const McpCountLinksSchema = LinkFilterQuerySchema.strict()
export const McpListTagsSchema = z.object({}).strict()
export const McpCheckLinksSchema = LinkCheckRequestSchema
export const McpDeleteLinkSchema = DeleteLinkSchema.strict()
export const McpUpdateLinkSchema = EditLinkSchema.strict()

/**
 * `id`, `createdAt` and `updatedAt` are filled by the server. `slug` stays
 * optional without the shared schema's generated default, which would otherwise
 * be advertised as a fresh random value on every `tools/list`. The handlers
 * parse the result with `CreateLinkSchema` to fill what is missing.
 */
export const McpCreateLinkSchema = CreateLinkSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({ slug: NewSlugSchema.optional().describe('The slug identifying the short link. Generated when omitted.') })
  .strict()

/**
 * The access-log dimensions an agent may group by. Left out: `ua` (the raw user
 * agent), `ip`, and `device` (a model name captured from the user agent). All
 * three are text a visitor chooses, with no shape to check it against. The
 * remaining visitor-influenced dimensions are filtered in `metric-names.ts`.
 * Listed explicitly so a dimension added to the access log is not offered to
 * agents until it is added here.
 */
const MCP_METRIC_TYPES = [
  'slug',
  'url',
  'referer',
  'country',
  'region',
  'city',
  'timezone',
  'language',
  'os',
  'browser',
  'browserType',
  'deviceType',
  'COLO',
  'latitude',
  'longitude',
] as const satisfies readonly MetricType[]

// The range check goes last: zod refuses to overwrite a key of a refined
// object, which the metrics schema does.
export const McpCountersSchema = FilterQuerySchema.strict().refine(isOrderedRange, ORDERED_RANGE_ISSUE)
export const McpViewsSchema = ViewsQuerySchema.strict().refine(isOrderedRange, ORDERED_RANGE_ISSUE)
export const McpHeatmapSchema = HeatmapQuerySchema.strict().refine(isOrderedRange, ORDERED_RANGE_ISSUE)
export const McpMetricsSchema = MetricsQuerySchema
  .extend({
    type: z.enum(MCP_METRIC_TYPES).describe('The access-log dimension to group by.'),
    limit: McpPageLimitSchema,
  })
  .strict()
  .refine(isOrderedRange, ORDERED_RANGE_ISSUE)
