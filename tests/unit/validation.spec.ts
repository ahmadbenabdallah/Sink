import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getImportIssueKind, makeZodValidator } from '../../app/utils/validation'

describe('makeZodValidator', () => {
  const validate = makeZodValidator(z.string().trim().max(5), () => 'Too long, translated')

  it('accepts a valid value', () => {
    expect(validate({ value: ' abcde ' })).toBeUndefined()
  })

  it('returns the caller message, never the zod text', () => {
    expect(validate({ value: 'abcdef' })).toBe('Too long, translated')
    expect(makeZodValidator(z.string().regex(/^[a-z]+$/), () => 'Invalid, translated')({ value: 'A1' }))
      .toBe('Invalid, translated')
  })
})

describe('getImportIssueKind', () => {
  const schema = z.object({
    links: z.array(z.object({
      url: z.string().min(1).max(30).url(),
      slug: z.string().max(10).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i).refine(slug => slug !== 'dashboard', 'slug is reserved'),
      comment: z.string().max(5).optional(),
      createdAt: z.number().int().optional(),
    })).min(1),
  })

  function kinds(link: Record<string, unknown>) {
    const result = schema.safeParse({ links: [{ url: 'https://example.com', slug: 'ok', ...link }] })
    return result.success ? [] : result.error.issues.map(getImportIssueKind)
  }

  it('maps slug problems', () => {
    expect(kinds({ slug: 'my_link' })).toEqual(['slug_invalid'])
    expect(kinds({ slug: 'dashboard' })).toEqual(['slug_reserved'])
    expect(kinds({ slug: 'a'.repeat(11) })).toEqual(['too_long'])
  })

  it('maps URL problems', () => {
    expect(kinds({ url: 'not a url' })).toEqual(['url_invalid'])
    expect(kinds({ url: undefined })).toEqual(['required'])
  })

  it('maps length and type problems', () => {
    expect(kinds({ comment: 'too long' })).toEqual(['too_long'])
    expect(kinds({ createdAt: 'yesterday' })).toEqual(['invalid'])
    expect(schema.safeParse({ links: [] }).error?.issues.map(getImportIssueKind)).toEqual(['required'])
  })
})
