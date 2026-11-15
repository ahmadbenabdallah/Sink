import type { CounterData, Link, LinkFormData, LinkListResponse, LinkSearchItem } from '@/types'

export type DashboardLinkStatus = 'active' | 'expired'

export type DashboardLink = Link & {
  tags?: string[]
}

export type DashboardLinkFormData = Omit<LinkFormData, 'tags'> & {
  tags: string[]
}

export type DashboardLinkSearchItem = LinkSearchItem & {
  expiration?: number
  tags?: string[]
}

export type DashboardLinkListResponse = Omit<LinkListResponse, 'links'> & {
  links: DashboardLink[]
  /** Sent by `/api/link/traffic`: the counts each link was ranked by, keyed by link id. */
  counters?: Record<string, CounterData>
}
