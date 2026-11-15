import { describe, expect, it } from 'vitest'
import { decodeTrafficCursor, encodeTrafficCursor, rankLinksByTraffic } from '../../server/utils/link-traffic'

const key = (slug: string, createdAt: number, id = `id-${slug}`) => ({ id, slug, createdAt })
const row = (slug: string, visits: number | string, visitors: number | string = 0, referers: number | string = 0) => ({ id: `id-${slug}`, visits, visitors, referers })

function slugs(result: ReturnType<typeof rankLinksByTraffic>) {
  return result.page.map(item => item.key.slug)
}

describe('rankLinksByTraffic', () => {
  const keys = [key('a', 100), key('b', 200), key('c', 300), key('d', 400), key('e', 500)]
  const rows = [row('a', 5, 1, 2), row('b', 9, 3, 1), row('c', 5, 4, 0), row('x-deleted', 99, 99, 99)]

  // R1: each metric has its own order.
  it('sorts by the chosen metric, highest first', () => {
    expect(slugs(rankLinksByTraffic(keys, rows, 'visits', null, 10)).slice(0, 3)).toEqual(['b', 'c', 'a'])
    expect(slugs(rankLinksByTraffic(keys, rows, 'visitors', null, 10)).slice(0, 3)).toEqual(['c', 'b', 'a'])
    expect(slugs(rankLinksByTraffic(keys, rows, 'referers', null, 10)).slice(0, 3)).toEqual(['a', 'b', 'e'])
  })

  // R4: ties go to the newer link, then to the slug.
  it('breaks ties by newer first, then by slug', () => {
    const tied = rankLinksByTraffic([key('m', 1), key('k', 2), key('j', 2)], [row('m', 3), row('k', 3), row('j', 3)], 'visits', null, 10)
    expect(slugs(tied)).toEqual(['j', 'k', 'm'])
  })

  // R5: no traffic counts as zero and comes last, newest first.
  it('puts links with no traffic last, newest first, with zero counts', () => {
    const result = rankLinksByTraffic(keys, rows, 'visits', null, 10)
    expect(slugs(result)).toEqual(['b', 'c', 'a', 'e', 'd'])
    expect(result.page.at(-1)).toEqual({ key: key('d', 400), counts: { visits: 0, visitors: 0, referers: 0 } })
  })

  // R3 and R7.
  it('ignores ids that are not among the links, and returns the counts it ranked with', () => {
    const result = rankLinksByTraffic(keys, rows, 'visits', null, 10)
    expect(slugs(result)).not.toContain('x-deleted')
    expect(result.page[0]).toEqual({ key: key('b', 200), counts: { visits: 9, visitors: 3, referers: 1 } })
  })

  it('compares numbers sent as strings as numbers', () => {
    const result = rankLinksByTraffic([key('a', 1), key('b', 2)], [row('a', '10'), row('b', '9')], 'visits', null, 10)
    expect(slugs(result)).toEqual(['a', 'b'])
    expect(result.page[0]!.counts.visits).toBe(10)
  })

  it('gives the same order for the same input, whatever order it arrives in', () => {
    const forward = slugs(rankLinksByTraffic(keys, rows, 'visits', null, 10))
    const backward = slugs(rankLinksByTraffic([...keys].reverse(), [...rows].reverse(), 'visits', null, 10))
    expect(backward).toEqual(forward)
  })

  // R6: pages hold the links strictly after the cursor's key.
  it('pages through a run of tied values without repeating or skipping a link', () => {
    const tied = Array.from({ length: 7 }, (_, i) => key(`t${i}`, 1000))
    const tiedRows = tied.map(k => row(k.slug, 4))
    const seen: string[] = []
    let after = null
    let complete = false
    while (!complete) {
      const page = rankLinksByTraffic(tied, tiedRows, 'visits', after, 3)
      seen.push(...slugs(page))
      after = page.last
      complete = page.complete
    }
    expect(seen).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6'])
  })

  it('keeps the page boundary when a link already shown drops in rank', () => {
    const first = rankLinksByTraffic(keys, rows, 'visits', null, 2)
    expect(slugs(first)).toEqual(['b', 'c'])
    // b loses its traffic before the next page: no link is skipped (a still
    // comes next), and b, now at zero and older than e and d, is shown again later.
    const second = rankLinksByTraffic(keys, [row('a', 5), row('c', 5)], 'visits', first.last, 2)
    expect(slugs(second)).toEqual(['a', 'e'])
    expect(slugs(rankLinksByTraffic(keys, [row('a', 5), row('c', 5)], 'visits', second.last, 2))).toEqual(['d', 'b'])
  })

  it('answers an empty last page past the end', () => {
    const result = rankLinksByTraffic(keys, rows, 'visits', { value: 0, createdAt: 0, slug: 'zzz' }, 10)
    expect(result).toEqual({ page: [], last: null, complete: true })
  })
})

describe('traffic cursor', () => {
  const filter = { sort: 'visits' as const, tag: 'promo', status: 'active' as const }

  it('round-trips a tag outside Latin-1', () => {
    const accented = { ...filter, tag: 'été-促销' }
    const cursor = encodeTrafficCursor(accented, { value: 1, createdAt: 2, slug: 'x' })
    expect(decodeTrafficCursor(cursor, accented)).toEqual({ value: 1, createdAt: 2, slug: 'x' })
  })

  it('round-trips the last sort key', () => {
    const cursor = encodeTrafficCursor(filter, { value: 9, createdAt: 200, slug: 'b' })
    expect(cursor.startsWith('t1:')).toBe(true)
    expect(decodeTrafficCursor(cursor, filter)).toEqual({ value: 9, createdAt: 200, slug: 'b' })
    expect(decodeTrafficCursor(undefined, filter)).toBeNull()
  })

  it.each([
    ['another sort', { ...filter, sort: 'visitors' as const }],
    ['another tag', { ...filter, tag: 'other' }],
    ['no tag', { ...filter, tag: undefined }],
    ['another status', { ...filter, status: 'expired' as const }],
  ])('refuses a cursor made for %s', (_label, other) => {
    const cursor = encodeTrafficCursor(filter, { value: 9, createdAt: 200, slug: 'b' })
    expect(() => decodeTrafficCursor(cursor, other)).toThrow(expect.objectContaining({ statusCode: 400, data: { code: 'invalid_cursor' } }))
  })

  it.each([
    ['a list cursor', `d1:v1:${btoa(JSON.stringify({ sort: 'newest', slug: 'b', createdAt: 1, status: 'active' }))}`],
    ['a malformed cursor', 't1:not-base64!'],
    ['a cursor missing its key', `t1:${btoa(JSON.stringify({ sort: 'visits', tag: 'promo', status: 'active' }))}`],
    ['a cursor whose JSON is null', `t1:${btoa('null')}`],
  ])('refuses %s', (_label, cursor) => {
    expect(() => decodeTrafficCursor(cursor, filter)).toThrow(expect.objectContaining({ statusCode: 400, data: { code: 'invalid_cursor' } }))
  })
})
