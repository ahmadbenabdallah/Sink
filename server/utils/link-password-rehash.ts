import { and, eq, isNotNull, like, ne, not } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { LINK_PASSWORD_HASH_PREFIX } from '#shared/utils/link-password'
import { links } from '../database/schema'
import { readCompletedLinkMigrationMarker } from '../services/link-store/migration'
import { hashLinkPassword } from './link-password'

// ponytail: bounded per cron run to stay inside Worker CPU limits; a large
// backlog drains over several daily runs. Raise it if instances need faster.
const REHASH_BATCH_LIMIT = 50

/**
 * Hashes link passwords that are still stored as plaintext in D1 (links migrated
 * from KV before migration started hashing). updatedAt is left alone so open
 * editors don't hit a version conflict; the KV cache entry is dropped so the next
 * read comes from D1.
 */
export async function rehashPlaintextLinkPasswords(env: Cloudflare.Env): Promise<number> {
  if (!await readCompletedLinkMigrationMarker(env))
    return 0

  const db = drizzle(env.DB)
  const rows = await db.select({ slug: links.slug, password: links.password })
    .from(links)
    .where(and(
      isNotNull(links.password),
      ne(links.password, ''),
      not(like(links.password, `${LINK_PASSWORD_HASH_PREFIX}%`)),
    ))
    .limit(REHASH_BATCH_LIMIT)

  let rehashed = 0
  for (const { slug, password } of rows) {
    if (!password)
      continue
    // Compare-and-swap on the old value: a concurrent edit wins.
    const result = await db.update(links)
      .set({ password: await hashLinkPassword(password) })
      .where(and(eq(links.slug, slug), eq(links.password, password)))
    if (result.meta.changes > 0) {
      rehashed++
      await env.KV.delete(`link:${slug}`)
    }
  }

  if (rehashed)
    console.info(`[link-password-rehash] Hashed ${rehashed} plaintext link passwords`)
  return rehashed
}
