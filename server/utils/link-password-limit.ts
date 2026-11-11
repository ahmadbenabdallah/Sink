/** Window of the `LINK_PASSWORD_LIMITER` binding in `wrangler.jsonc`; sent as `Retry-After` when limited. */
export const LINK_PASSWORD_LIMIT_PERIOD_SECONDS = 60

interface LinkPasswordLimiter {
  limit: (options: { key: string }) => Promise<{ success: boolean }>
}

/**
 * Bucket for a client address. An IPv6 host usually controls a whole /64, so IPv6
 * addresses are reduced to their first four groups; IPv4 addresses are used as is.
 */
function clientBucket(ip: string | undefined): string {
  if (!ip)
    return 'unknown'
  if (!ip.includes(':') || ip.includes('.'))
    return ip

  const [head = '', tail] = ip.toLowerCase().split('::')
  const groups = head ? head.split(':') : []
  if (tail !== undefined) {
    const tailGroups = tail ? tail.split(':') : []
    groups.push(...Array.from<string>({ length: Math.max(0, 8 - groups.length - tailGroups.length) }).fill('0'), ...tailGroups)
  }
  return groups.slice(0, 4).join(':')
}

/**
 * Counts one link-password guess and says whether it may be verified.
 *
 * Fails open (allows, with a warning) when the binding is missing or errors, so an
 * environment without it keeps redirecting. Clients without an IP (never the case
 * behind Cloudflare, which always sets `cf-connecting-ip`) share one bucket per slug.
 */
// ponytail: Workers Rate Limiting binding, keyed by slug + client IP. Known ceilings:
// counters are per Cloudflare location and eventually consistent, so a burst can exceed
// the limit; an attacker rotating IPs is not stopped by a per-IP key; successful attempts
// count too, so a client sending `x-link-password` on every request is capped as well.
// Upgrade path if a link needs a strict global budget: a per-slug Durable Object counter.
export async function allowLinkPasswordAttempt(
  limiter: LinkPasswordLimiter | undefined,
  slug: string,
  ip: string | undefined,
): Promise<boolean> {
  if (!limiter) {
    console.warn({ event: 'link_password.limiter.unavailable', reason: 'binding missing' })
    return true
  }

  try {
    const { success } = await limiter.limit({ key: `${slug}:${clientBucket(ip)}` })
    return success
  }
  catch {
    console.warn({ event: 'link_password.limiter.unavailable', reason: 'limit call failed' })
    return true
  }
}
