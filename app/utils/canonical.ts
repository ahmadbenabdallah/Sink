/**
 * Canonical page URL: the configured public site URL (NUXT_PUBLIC_SITE_URL)
 * when set, otherwise the origin the page was served from.
 */
export function getCanonicalUrl(path: string, siteUrl: string, origin: string): string {
  const base = siteUrl.trim() || origin
  return `${base.replace(/\/+$/, '')}${path}`
}
