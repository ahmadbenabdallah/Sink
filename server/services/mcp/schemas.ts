import type { MetricType } from '../../utils/analytics-queries'
import { z } from 'zod'
import {
  CreateLinkSchema,
  DeleteLinkSchema,
  EditLinkPasswordSchema,
  LinkFieldsSchema,
  LinkFilterQuerySchema,
  LinkSlugQuerySchema,
  ListLinksQuerySchema,
  NewSlugSchema,
  SearchLinksQuerySchema,
  TagsFieldSchema,
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

const linkFields = LinkFieldsSchema.shape

/**
 * Makes an optional link field removable with null. The description moves to
 * the outside and says so; without that it would sit inside the "or null"
 * alternative, where a client reading the property would not find it.
 */
function removable<Field extends z.ZodType>(field: Field) {
  return field.nullable().describe(`${field.description} null removes it.`)
}

/**
 * `update_link` is a patch: a field that is absent is kept and `null` removes
 * it. Only the slug is required, and the URL cannot be removed. Each field
 * reuses the shared field schema, so the validation rules are the same as for
 * an edit. Nothing here has a default: the shared tags schema defaults to an
 * empty list, which would turn "tags not sent" into "remove all tags".
 */
export const McpUpdateLinkSchema = z.object({
  slug: linkFields.slug,
  url: linkFields.url.optional(),
  comment: removable(linkFields.comment),
  expiration: removable(linkFields.expiration),
  title: removable(linkFields.title),
  description: removable(linkFields.description),
  image: removable(linkFields.image),
  apple: removable(linkFields.apple),
  google: removable(linkFields.google),
  cloaking: removable(linkFields.cloaking),
  redirectWithQuery: removable(linkFields.redirectWithQuery),
  proxy: removable(linkFields.proxy),
  password: EditLinkPasswordSchema.nullable().describe('Password protection for the link. null or an empty string clears it; omitting keeps the stored one.'),
  unsafe: linkFields.unsafe.nullable().describe('Show a warning page before redirecting. When the url changes and this is not sent, a stored true is kept and a stored false is checked again by the safety lookup. null removes the flag and leaves a changed url to the lookup.'),
  geo: removable(linkFields.geo),
  tags: TagsFieldSchema.nullable().optional().describe('Up to 10 normalized link tags, each 1-32 characters. Replaces the whole list; null empties it.'),
}).strict()

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
