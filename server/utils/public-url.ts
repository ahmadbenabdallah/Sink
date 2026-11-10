export function isPublicHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return false

    const rawHostname = parsed.hostname.toLowerCase()
    const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname.replace(/\.+$/, '')
    if (hostname === 'localhost' || hostname.endsWith('.localhost'))
      return false

    return !isBlockedIp(hostname)
  }
  catch {
    return false
  }
}

const MAX_REDIRECTS = 5

/**
 * fetch() for user-supplied URLs: follows redirects manually so every hop must
 * pass isPublicHttpUrl. Mirrors the Fetch spec redirect rules (303, or 301/302
 * after POST, become a bodyless GET; Authorization is dropped across origins).
 * ponytail: literal-IP checks only, no DNS resolution — Workers cannot route to
 * private networks; resolve via DoH here if Sink ever runs outside Workers.
 */
export async function fetchPublicHttpUrl(url: string, init: RequestInit = {}): Promise<Response> {
  let target = url
  let request: RequestInit = { ...init, headers: new Headers(init.headers) }

  for (let redirects = 0; ; redirects++) {
    if (!isPublicHttpUrl(target))
      throw new Error('URL is not allowed for server-side fetching')

    // nosemgrep: sink-no-raw-fetch-in-server -- this is the checked helper itself
    const response = await fetch(target, { ...request, redirect: 'manual' })
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !location)
      return response

    await response.body?.cancel()
    if (redirects === MAX_REDIRECTS)
      throw new Error('Too many redirects')

    const next = new URL(location, target)
    const headers = new Headers(request.headers)
    if (next.origin !== new URL(target).origin)
      headers.delete('authorization')
    const method = (request.method ?? 'GET').toUpperCase()
    const toGet = response.status === 303
      ? method !== 'GET' && method !== 'HEAD'
      : (response.status === 301 || response.status === 302) && method === 'POST'
    request = toGet ? { ...request, method: 'GET', body: undefined, headers } : { ...request, headers }
    target = next.toString()
  }
}

function isBlockedIp(hostname: string): boolean {
  if (hostname.includes(':'))
    return isBlockedIpv6(hostname)

  return isBlockedIpv4(hostname)
}

function isBlockedIpv4(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4)
    return false

  const bytes = parts.map((part) => {
    if (!/^\d+$/.test(part))
      return Number.NaN

    const value = Number(part)
    return value >= 0 && value <= 255 ? value : Number.NaN
  })

  if (bytes.some(Number.isNaN))
    return false

  const [a, b] = bytes as [number, number, number, number]

  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
}

function isBlockedIpv6(hostname: string): boolean {
  const firstSegment = Number.parseInt(hostname.split(':', 1)[0] || '0', 16)
  if (hostname === '::'
    || hostname === '::1'
    || (firstSegment >= 0xFC00 && firstSegment <= 0xFDFF)
    || (firstSegment >= 0xFE80 && firstSegment <= 0xFEBF)
    || (firstSegment >= 0xFF00 && firstSegment <= 0xFFFF)) {
    return true
  }

  const mappedMatch = hostname.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([\da-f]{1,4}):([\da-f]{1,4}))$/i)
  if (!mappedMatch)
    return false

  if (mappedMatch[1])
    return isBlockedIpv4(mappedMatch[1])

  const high = Number.parseInt(mappedMatch[2]!, 16)
  const low = Number.parseInt(mappedMatch[3]!, 16)
  return isBlockedIpv4(`${high >> 8}.${high & 0xFF}.${low >> 8}.${low & 0xFF}`)
}
