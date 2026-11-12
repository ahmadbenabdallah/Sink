import type { RateLimiter } from './rate-limit'
import { allowAttempt, clientBucket } from './rate-limit'

/** Window of the `LINK_PASSWORD_LIMITER` binding in `wrangler.jsonc`; sent as `Retry-After` when limited. */
export const LINK_PASSWORD_LIMIT_PERIOD_SECONDS = 60

/**
 * Counts one link-password guess, per slug and client address, and says whether it
 * may be verified. Successful attempts count too, so a client sending
 * `x-link-password` on every request is capped as well. See `allowAttempt` for how
 * a missing or failing binding is handled.
 */
export function allowLinkPasswordAttempt(
  limiter: RateLimiter | undefined,
  slug: string,
  ip: string | undefined,
): Promise<boolean> {
  return allowAttempt(limiter, `${slug}:${clientBucket(ip)}`, 'link_password.limiter.unavailable')
}
