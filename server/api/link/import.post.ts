import type { ImportResult } from '#shared/schemas/import'
import { ImportDataSchema } from '#shared/schemas/import'
import { nanoid } from '#shared/schemas/link'

defineRouteMeta({
  openAPI: {
    description: 'Import links from exported data',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: { 'application/json': {} },
    },
  },
})

export default eventHandler(async (event) => {
  assertLinkWritesAllowed(event, 'import')

  const importData = await readValidatedBody(event, ImportDataSchema.parse)
  const { importRequestLimit } = useRuntimeConfig(event)
  if (importData.links.length > importRequestLimit) {
    throw createError({
      status: 400,
      statusText: `Too many links. Maximum ${importRequestLimit} links per request.`,
    })
  }

  const result: ImportResult = {
    success: 0,
    skipped: 0,
    failed: 0,
    successItems: [],
    skippedItems: [],
    failedItems: [],
  }

  const chunkSize = 4
  for (let offset = 0; offset < importData.links.length; offset += chunkSize) {
    const chunk = importData.links.slice(offset, offset + chunkSize)
    const prepared = await Promise.all(chunk.map(async (linkData, chunkIndex) => {
      const index = offset + chunkIndex

      try {
        const slug = normalizeSlug(event, linkData.slug)
        const now = Math.floor(Date.now() / 1000)
        const link = {
          ...linkData,
          id: linkData.id || nanoid(10)(),
          slug,
          createdAt: linkData.createdAt ?? now,
          updatedAt: linkData.updatedAt ?? now,
        }
        if (link.password)
          link.password = await normalizeLinkPasswordForStorage(link.password)
        return { index, linkData, link }
      }
      catch (error) {
        return { index, linkData, error }
      }
    }))

    const writable = prepared.filter(item => 'link' in item)
    const writeResults = await createLinks(event, writable.map(item => item.link!))
    let writeIndex = 0
    for (const item of prepared) {
      if ('error' in item) {
        result.failed++
        result.failedItems.push({ index: item.index, slug: item.linkData.slug, url: item.linkData.url, reason: publicFailureReason(item.error, 'Failed to save link', { operation: 'import', slug: item.linkData.slug }) })
        continue
      }

      const writeResult = writeResults[writeIndex++]!
      if ('error' in writeResult) {
        result.failed++
        result.failedItems.push({ index: item.index, slug: item.link.slug, url: item.linkData.url, reason: publicFailureReason(writeResult.error, 'Failed to save link', { operation: 'import', slug: item.link.slug }) })
      }
      else if (!writeResult.created) {
        result.skippedItems.push({ index: item.index, slug: item.link.slug, url: item.linkData.url })
        result.skipped++
      }
      else {
        result.successItems.push({ index: item.index, slug: item.link.slug, url: item.linkData.url })
        result.success++
      }
    }
  }

  setResponseHeader(event, 'Cache-Control', 'no-store')

  return result
})
