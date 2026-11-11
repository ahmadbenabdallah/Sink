import type { z } from 'zod'
import type { AnyFieldApi } from '@/types'

export function isInvalid(field: AnyFieldApi) {
  return field.state.meta.isTouched && !field.state.meta.isValid
}

export function getAriaInvalid(field: AnyFieldApi) {
  return isInvalid(field) ? 'true' : undefined
}

/** Validates with `schema` but reports the caller's translated `message`, never zod's own text. */
export function makeZodValidator<TSchema extends z.ZodType>(schema: TSchema, message: () => string) {
  return ({ value }: { value: unknown }) => schema.safeParse(value).success ? undefined : message()
}

export type ImportIssueKind = 'slug_invalid' | 'slug_reserved' | 'url_invalid' | 'required' | 'too_long' | 'invalid'

/** Classifies a zod issue from the import file so the UI can translate it instead of printing zod text. */
export function getImportIssueKind(issue: z.core.$ZodIssue): ImportIssueKind {
  const isSlug = issue.path.at(-1) === 'slug'
  switch (issue.code) {
    case 'invalid_format':
      if (issue.format === 'url')
        return 'url_invalid'
      return isSlug ? 'slug_invalid' : 'invalid'
    case 'custom':
      // The only refinement on an imported slug is the reserved-slug check.
      return isSlug ? 'slug_reserved' : 'invalid'
    case 'too_big':
      return 'too_long'
    case 'too_small':
      return 'required'
    case 'invalid_type':
      // zod omits the input from issues; a missing field is only visible in the message.
      return issue.message.endsWith('received undefined') ? 'required' : 'invalid'
    default:
      return 'invalid'
  }
}
