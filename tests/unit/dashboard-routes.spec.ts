import { describe, expect, it } from 'vitest'
import { dashboardPageOf, isDashboardPageActive } from '../../app/utils/dashboard-routes'

describe('dashboard routes', () => {
  it('matches the MCP connectors page as itself, not as its parent', () => {
    expect(dashboardPageOf('/dashboard/connectors/mcp')).toBe('mcpConnectors')
    expect(dashboardPageOf('/dashboard/connectors')).toBe('connectors')
    expect(dashboardPageOf('/dashboard/links')).toBe('links')
    expect(dashboardPageOf('/dashboard/unknown')).toBe('')
  })

  it('marks a parent active on its child page, and the child on itself only', () => {
    expect(isDashboardPageActive('mcpConnectors', 'connectors')).toBe(true)
    expect(isDashboardPageActive('mcpConnectors', 'mcpConnectors')).toBe(true)
    expect(isDashboardPageActive('connectors', 'mcpConnectors')).toBe(false)
    expect(isDashboardPageActive('links', 'connectors')).toBe(false)
    expect(isDashboardPageActive('', 'connectors')).toBe(false)
  })
})
