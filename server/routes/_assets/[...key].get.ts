import { SlugSchema } from '#shared/schemas/link'
import { IMAGE_ALLOWED_TYPES } from '#shared/utils/image'

const slugValidator = SlugSchema

export default eventHandler(async (event) => {
  const R2 = requireR2Bucket(event.context.cloudflare.env)
  const key = getRouterParam(event, 'key')

  if (!key) {
    throw createError({ status: 400, statusText: 'Key is required' })
  }

  // Only allow access to images/ path
  if (!key.startsWith('images/')) {
    throw createError({ status: 403, statusText: 'Access denied' })
  }

  // Validate slug in path: images/{slug}/{filename}
  const parts = key.split('/')
  if (parts.length < 3) {
    throw createError({ status: 400, statusText: 'Invalid path format' })
  }

  const slug = parts[1]
  const slugResult = slugValidator.safeParse(slug)
  if (!slugResult.success) {
    throw createError({ status: 400, statusText: 'Invalid slug format' })
  }

  const object = await R2.get(key)

  if (!object) {
    throw createError({ status: 404, statusText: 'Image not found' })
  }

  // Only image types the upload endpoint accepts are served as such; anything else must not render.
  const storedType = object.httpMetadata?.contentType
  const contentType = storedType && IMAGE_ALLOWED_TYPES.includes(storedType) ? storedType : 'application/octet-stream'

  setHeader(event, 'Content-Type', contentType)
  if (contentType !== storedType)
    setHeader(event, 'Content-Disposition', 'attachment')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Cache-Control', 'public, max-age=31536000, immutable')
  setHeader(event, 'ETag', object.etag)

  return object.body
})
