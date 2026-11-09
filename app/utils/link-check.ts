import type { DashboardQuery, LinksQueryState } from '@/utils/dashboard-query'
import { parseAnalysisQuery, serializeAnalysisQuery, serializeLinksQuery } from '@/utils/dashboard-query'

export function getDashboardLinksLocation(state: LinksQueryState) {
  return {
    path: '/dashboard/links',
    query: serializeLinksQuery(state),
  }
}

export function getDashboardLinkDetailLocation(slug: string, sourceQuery?: DashboardQuery) {
  return {
    path: '/dashboard/link',
    query: sourceQuery
      ? serializeAnalysisQuery(parseAnalysisQuery(sourceQuery, false), { slug, allowSlugs: false })
      : { slug },
  }
}

export function getDashboardLinkDetailUrl(slug: string): string {
  return `/dashboard/link?slug=${encodeURIComponent(slug)}`
}
