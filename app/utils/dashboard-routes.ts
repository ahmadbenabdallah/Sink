import type { Component } from 'vue'
import { Activity, Bot, ChartArea, FolderSync, Link, Plug, ScanSearch } from '@lucide/vue'

export interface DashboardRouteConfig {
  readonly paths: readonly string[]
  readonly titleKey: string
  readonly icon: Component
  /** The page this one sits under in the sidebar: it is shown active too. */
  readonly parent?: string
}

export const DASHBOARD_ROUTES = {
  links: {
    paths: ['/dashboard/links'],
    titleKey: 'nav.links',
    icon: Link,
  },
  link: {
    paths: ['/dashboard/link'],
    titleKey: 'nav.links',
    icon: Link,
  },
  analysis: {
    paths: ['/dashboard/analysis'],
    titleKey: 'nav.analysis',
    icon: ChartArea,
  },
  realtime: {
    paths: ['/dashboard/realtime'],
    titleKey: 'nav.realtime',
    icon: Activity,
  },
  check: {
    paths: ['/dashboard/check'],
    titleKey: 'nav.check',
    icon: ScanSearch,
  },
  migrate: {
    paths: ['/dashboard/migrate'],
    titleKey: 'nav.migrate',
    icon: FolderSync,
  },
  connectors: {
    // Only a redirect to its first child; kept so the sidebar group has a home.
    paths: ['/dashboard/connectors'],
    titleKey: 'nav.connectors',
    icon: Plug,
  },
  mcpConnectors: {
    paths: ['/dashboard/connectors/mcp'],
    titleKey: 'nav.mcp_connectors',
    icon: Bot,
    parent: 'connectors',
  },
} as const satisfies Record<string, DashboardRouteConfig>

export type DashboardRouteName = keyof typeof DASHBOARD_ROUTES

/** The page a path belongs to, matched exactly, or '' for none. */
export function dashboardPageOf(path: string): DashboardRouteName | '' {
  for (const [page, config] of Object.entries(DASHBOARD_ROUTES)) {
    if ((config.paths as readonly string[]).includes(path))
      return page as DashboardRouteName
  }
  return ''
}

/** Whether `page` is the current page or the parent of it. */
export function isDashboardPageActive(current: DashboardRouteName | '', page: DashboardRouteName): boolean {
  if (!current)
    return false
  const config: DashboardRouteConfig = DASHBOARD_ROUTES[current]
  return current === page || config.parent === page
}
