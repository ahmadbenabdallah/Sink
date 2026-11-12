/**
 * Stable codes the server attaches to its errors as `createError({ ..., data: { code } })`.
 * The dashboard translates them (`errors.<code>` in the `core` locale module); the English
 * `statusText` stays the contract for other API consumers.
 * `tests/unit/api-error-codes.spec.ts` keeps this list, the server and the translations in step.
 */
export const API_ERROR_CODES = [
  'ai_not_enabled',
  'cloudflare_credentials_rejected',
  'cloudflare_request_failed',
  'file_required',
  'file_too_large',
  'forbidden',
  'invalid_cursor',
  'invalid_file_type',
  'invalid_slug',
  'link_exists',
  'link_migration_required',
  'link_modified',
  'link_not_found',
  'masked_password',
  'not_found',
  'preview_mode',
  'r2_not_configured',
  'slug_required',
  'token_too_short',
  'too_many_links',
  'too_many_requests',
  'unauthorized',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]
