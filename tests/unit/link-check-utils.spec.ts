import { describe, expect, it, vi } from 'vitest'
import {
  getDashboardLinkDetailLocation,
  getDashboardLinkDetailUrl,
  getDashboardLinksLocation,
} from '../../app/utils/link-check'

vi.mock('@/utils/dashboard-query', async () => import('../../app/utils/dashboard-query'))

describe('dashboard link detail navigation', () => {
  it('keeps analysis time and view while removing list slugs', () => {
    expect(getDashboardLinkDetailLocation('detail-slug', {
      from: '100',
      to: '200',
      slugs: ['beta', 'alpha'],
      view: 'heatmap',
      metric: 'visitors',
    })).toEqual({
      path: '/dashboard/link',
      query: {
        slug: 'detail-slug',
        from: '100',
        to: '200',
        view: 'heatmap',
        metric: 'visitors',
      },
    })
  })

  it('keeps an analysis preset and drops legacy filter slugs', () => {
    expect(getDashboardLinkDetailLocation('detail-slug', {
      range: 'today',
      filters: JSON.stringify({ slug: 'legacy-list-slug' }),
    })).toEqual({
      path: '/dashboard/link',
      query: { slug: 'detail-slug', range: 'today' },
    })
  })

  it('returns only the slug when there is no source query', () => {
    expect(getDashboardLinkDetailLocation('detail-slug')).toEqual({
      path: '/dashboard/link',
      query: { slug: 'detail-slug' },
    })
  })

  it('returns the plain links list for default filters', () => {
    expect(getDashboardLinksLocation({ status: 'active', sort: 'newest' })).toEqual({
      path: '/dashboard/links',
      query: {},
    })
  })

  it('carries non-default status, sort, and tag back to the links list', () => {
    expect(getDashboardLinksLocation({ status: 'expired', sort: 'az', tag: 'product' })).toEqual({
      path: '/dashboard/links',
      query: { status: 'expired', sort: 'az', tag: 'product' },
    })
  })

  it('keeps only the filters that differ from the defaults', () => {
    expect(getDashboardLinksLocation({ status: 'active', sort: 'oldest' })).toEqual({
      path: '/dashboard/links',
      query: { sort: 'oldest' },
    })
  })

  it('encodes the slug in a detail URL', () => {
    expect(getDashboardLinkDetailUrl('space / 中文?&=#')).toBe(
      '/dashboard/link?slug=space%20%2F%20%E4%B8%AD%E6%96%87%3F%26%3D%23',
    )
  })
})
