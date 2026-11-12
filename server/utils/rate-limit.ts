/** The Workers Rate Limiting binding: one call that counts an attempt and says whether it is within the limit. */
export interface RateLimiter {
  limit: (options: { key: string }) => Promise<{ success: boolean }>
}

/**
 * Bucket for a client address. An IPv6 host usually controls a whole /64, so IPv6
 * addresses are reduced to their first four groups; IPv4 addresses are used as is.
 * Clients without an address (never the case behind Cloudflare, which always sets
 * `cf-connecting-ip`) share the bucket `unknown`.
 */
export function clientBucket(ip: string | undefined): string {
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

const warnedMissingBinding = new Set<string>()

/**
 * Counts one attempt under `key` and says whether it may go ahead.
 *
 * Fails open: when the binding is missing or the call errors, the attempt is
 * allowed and a warning is logged under `event`, so an environment without the
 * binding (a Pages deployment, local dev) keeps working. A missing binding is
 * logged once per event, because some callers run on every request.
 */
// ponytail: Workers Rate Limiting binding. Known ceilings: counters are per Cloudflare
// location and eventually consistent, so a burst can exceed the limit; the binding
// has no read-only check, so every call counts and failures cannot be counted on their
// own; a per-address key does not stop an attacker who rotates addresses, and lets
// someone behind the same address use up the budget for everyone there. Upgrade path
// for a strict global budget: a Durable Object counter.
export async function allowAttempt(limiter: RateLimiter | undefined, key: string, event: string): Promise<boolean> {
  if (!limiter) {
    if (!warnedMissingBinding.has(event)) {
      warnedMissingBinding.add(event)
      console.warn({ event, reason: 'binding missing' })
    }
    return true
  }

  try {
    const { success } = await limiter.limit({ key })
    return success
  }
  catch {
    console.warn({ event, reason: 'limit call failed' })
    return true
  }
}
