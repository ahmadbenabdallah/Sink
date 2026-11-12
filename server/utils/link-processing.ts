import type { H3Event } from 'h3'
import type { EditLink, Link } from '#shared/schemas/link'

const editableOptionalLinkFields = [
  'comment',
  'title',
  'description',
  'image',
  'apple',
  'google',
  'cloaking',
  'redirectWithQuery',
  'proxy',
  'expiration',
  'unsafe',
  'geo',
  'tags',
] as const satisfies readonly (keyof Link)[]

/**
 * A partial change to a stored link. A field that is absent is kept, and `null`
 * removes it. The slug identifies the link and the URL cannot be removed.
 */
export type LinkPatch = Pick<EditLink, 'slug'>
  & { url?: EditLink['url'] }
  & { [Field in Exclude<keyof EditLink, 'slug' | 'url'>]?: EditLink[Field] | null }

export interface LinkResponse {
  link: Link
  shortLink: string
}

/**
 * Preview instances cap link lifetime instead of rejecting creation outright,
 * so the guard only protects mutations of existing links (edit, delete, bulk
 * import). The write operations below enforce it, and the REST routes call it
 * again up front so a preview instance answers 403 without first validating
 * the request body.
 */
export function assertLinkWritesAllowed(event: H3Event, action: string): void {
  if (useRuntimeConfig(event).public.previewMode) {
    throw createError({
      status: 403,
      statusText: `Preview mode cannot ${action} links.`,
      data: { code: 'preview_mode', action },
    })
  }
}

/** An explicit `unsafe` flag from the caller wins over the safety lookup. */
async function detectUnsafeLink(event: H3Event, link: Pick<Link, 'url' | 'unsafe'>): Promise<void> {
  if (link.unsafe === undefined && !await isSafeUrl(event, link.url))
    link.unsafe = true
}

async function prepareIncomingLink(event: H3Event, link: Link): Promise<void> {
  link.slug = normalizeSlug(event, link.slug)
  await detectUnsafeLink(event, link)
}

async function hashNewLinkPassword(link: Link): Promise<void> {
  if (link.password)
    link.password = await hashLinkPassword(link.password)
}

function buildLinkResponse(event: H3Event, link: Link): LinkResponse {
  return {
    link: sanitizeLinkPassword(link),
    shortLink: buildShortLink(event, link.slug),
  }
}

function mergeEditableLink(existingLink: Link, link: EditLink): Link {
  const { password: _password, ...linkWithoutPassword } = link
  const newLink = {
    ...existingLink,
    ...linkWithoutPassword,
    id: existingLink.id,
    createdAt: existingLink.createdAt,
    updatedAt: Math.max(Math.floor(Date.now() / 1000), existingLink.updatedAt + 1),
  }

  for (const field of editableOptionalLinkFields) {
    if (link[field] === undefined)
      delete newLink[field]
  }

  return newLink
}

/** An empty password clears protection, an absent one keeps the stored hash. */
async function applyEditableLinkPassword(newLink: Link, password?: string): Promise<void> {
  if (password === '')
    delete newLink.password
  else if (password !== undefined)
    newLink.password = await hashLinkPassword(password)
  else if (newLink.password)
    newLink.password = await normalizeLinkPasswordForStorage(newLink.password)
}

export async function saveNewLink(event: H3Event, link: Link): Promise<LinkResponse> {
  await prepareIncomingLink(event, link)
  await hashNewLinkPassword(link)

  if (!await createLink(event, link))
    throw createError({ status: 409, statusText: 'Link already exists', data: { code: 'link_exists' } })

  return buildLinkResponse(event, link)
}

export async function upsertLink(event: H3Event, link: Link): Promise<LinkResponse & { status: 'created' | 'existing' }> {
  await prepareIncomingLink(event, link)

  const existingLink = await getAuthoritativeLink(event, link.slug)
  if (existingLink)
    return { ...buildLinkResponse(event, existingLink), status: 'existing' }

  await hashNewLinkPassword(link)
  if (await createLink(event, link))
    return { ...buildLinkResponse(event, link), status: 'created' }

  // Another writer claimed the slug between the lookup and the insert.
  const racedLink = await getAuthoritativeLink(event, link.slug)
  if (!racedLink)
    throw createError({ status: 409, statusText: 'Link already exists', data: { code: 'link_exists' } })

  return { ...buildLinkResponse(event, racedLink), status: 'existing' }
}

/**
 * Turns a patch into the complete link `editStoredLink` expects, by laying the
 * sent fields over the stored ones.
 *
 * - The stored password hash is left out: an absent password keeps it, exactly
 *   as it does for a full edit, and `null` clears it like an empty string.
 * - Tags are always a list, so `null` empties them.
 * - A stored `unsafe: false` was a verdict on the stored URL. When the URL
 *   changes and the caller sent no flag, it is dropped so the safety lookup
 *   decides again. A stored `unsafe: true` is kept: the lookup is optional and
 *   passes a link when it fails, so a warning must not depend on it.
 * - `unsafe: null` removes the flag, which leaves a changed URL to the lookup
 *   exactly like a link that never had one.
 *
 * Only the editable fields are read from the patch, so a caller that skipped
 * the input schema cannot store anything else.
 */
function applyLinkPatch(existingLink: Link, patch: LinkPatch): EditLink {
  const { password: _storedHash, ...stored } = existingLink
  const link: Record<string, unknown> = stored

  if (patch.url !== undefined)
    link.url = patch.url

  for (const field of editableOptionalLinkFields) {
    const value = patch[field]
    if (value === undefined)
      continue
    if (value !== null)
      link[field] = value
    else if (field === 'tags')
      link.tags = []
    else
      delete link[field]
  }

  const urlChanged = link.url !== existingLink.url
  if (urlChanged && patch.unsafe === undefined && existingLink.unsafe === false)
    delete link.unsafe

  return { ...link, password: patch.password === null ? '' : patch.password } as EditLink
}

/**
 * The one path that changes a stored link. `resolve` receives the stored link
 * and returns the complete link to store: a full edit returns what the caller
 * sent, a patch lays the sent fields over the stored ones.
 */
async function editStoredLink(event: H3Event, slug: string, resolve: (existingLink: Link) => EditLink): Promise<LinkResponse> {
  assertLinkWritesAllowed(event, 'edit')
  const normalizedSlug = normalizeSlug(event, slug)

  const existingLink = await getAnyAuthoritativeLink(event, normalizedSlug)
  if (!existingLink)
    throw createError({ status: 404, statusText: 'Link not found', data: { code: 'link_not_found' } })

  const link = { ...resolve(existingLink), slug: normalizedSlug }
  if (link.url !== existingLink.url)
    await detectUnsafeLink(event, link)

  const newLink = mergeEditableLink(existingLink, link)
  await applyEditableLinkPassword(newLink, link.password)

  if (!await updateLink(event, newLink, { id: existingLink.id, updatedAt: existingLink.updatedAt }))
    throw createError({ status: 409, statusText: 'Link was modified or replaced', data: { code: 'link_modified' } })

  return buildLinkResponse(event, newLink)
}

/** Replaces a link: every optional field the caller left out is removed. */
export function replaceLink(event: H3Event, link: EditLink): Promise<LinkResponse> {
  return editStoredLink(event, link.slug, () => link)
}

/** Changes only the fields the caller sent; see `LinkPatch`. */
export function patchLink(event: H3Event, patch: LinkPatch): Promise<LinkResponse> {
  return editStoredLink(event, patch.slug, existingLink => applyLinkPatch(existingLink, patch))
}

/** Resolves to whether a link was there to delete. */
export async function removeLink(event: H3Event, slug: string): Promise<boolean> {
  assertLinkWritesAllowed(event, 'delete')
  return await deleteLink(event, normalizeSlug(event, slug))
}
