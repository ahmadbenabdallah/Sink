import { CalendarDate } from '@internationalized/date'
import { describe, expect, it, vi } from 'vitest'
import {
  createLinkFormInitialValues,
  getGeoRoutesUrlValidationError,
  getInvalidAdvancedSections,
  getLinkSlugValidationError,
  getLinkUrlValidationError,
  normalizeLinkFormSubmitPayload,
} from '../../app/utils/link-form'
import { LINK_PASSWORD_MASK_PREFIX } from '../../shared/utils/link-password'

vi.mock('#shared/utils/link-password', async () => import('../../shared/utils/link-password'))

describe('link form values', () => {
  it('creates the current defaults for a new link', () => {
    expect(createLinkFormInitialValues({})).toEqual({
      url: '',
      slug: '',
      comment: '',
      tags: [],
      expiration: undefined,
      google: '',
      apple: '',
      title: '',
      description: '',
      image: '',
      cloaking: false,
      redirectWithQuery: false,
      proxy: false,
      password: '',
      unsafe: false,
      geo: [],
    })
  })

  it('maps stored expiration and geo records into editable values', () => {
    const expiration = Math.floor(new Date(2030, 0, 2, 12).getTime() / 1000)

    const values = createLinkFormInitialValues({
      expiration,
      geo: { us: ' https://us.example.com ', CA: 'https://ca.example.com' },
    })

    expect(values.expiration?.toString()).toBe('2030-01-02')
    expect(values.geo).toEqual([
      { country: 'us', url: ' https://us.example.com ' },
      { country: 'CA', url: 'https://ca.example.com' },
    ])
  })
})

describe('link URL validation', () => {
  it('distinguishes required, invalid, and over-limit URLs', () => {
    expect(getLinkUrlValidationError('  ', 20)).toEqual({ kind: 'required' })
    expect(getLinkUrlValidationError('not a URL', 20)).toEqual({ kind: 'invalid' })
    expect(getLinkUrlValidationError('https://example.com/long', 20)).toEqual({
      kind: 'too_long',
      length: 24,
    })
  })

  it('accepts complete URLs and optional empty values', () => {
    expect(getLinkUrlValidationError('https://example.com', 100)).toBeUndefined()
    expect(getLinkUrlValidationError('', 100, true)).toBeUndefined()
  })
})

describe('geo route URL validation', () => {
  it('accepts no routes, valid URLs, and rows whose URL is still empty', () => {
    expect(getGeoRoutesUrlValidationError([], 100)).toBeUndefined()
    expect(getGeoRoutesUrlValidationError([{ url: 'https://us.example.com' }, { url: '  ' }], 100)).toBeUndefined()
  })

  it('reports the first invalid route', () => {
    expect(getGeoRoutesUrlValidationError([
      { url: 'https://ok.example.com' },
      { url: 'https://example.com/long' },
      { url: 'not a URL' },
    ], 22)).toEqual({ kind: 'too_long', length: 24 })
    expect(getGeoRoutesUrlValidationError([{ url: 'not a URL' }], 20)).toEqual({ kind: 'invalid' })
  })
})

describe('invalid advanced sections', () => {
  it('returns nothing when no advanced field is invalid', () => {
    expect(getInvalidAdvancedSections(() => false)).toEqual([])
  })

  it('maps every invalid advanced field to its accordion section, once each, in field order', () => {
    const invalid = new Set(['image', 'title', 'password', 'geo'])
    expect(getInvalidAdvancedSections(name => invalid.has(name))).toEqual(['link_settings', 'og', 'geo'])
    expect(getInvalidAdvancedSections(name => name === 'apple')).toEqual(['device'])
    expect(getInvalidAdvancedSections(name => name === 'google')).toEqual(['device'])
    expect(getInvalidAdvancedSections(name => name === 'description')).toEqual(['og'])
  })
})

describe('link form submit payload', () => {
  function formValues(overrides: Partial<ReturnType<typeof createLinkFormInitialValues>> = {}) {
    return {
      ...createLinkFormInitialValues({}),
      url: 'https://example.com',
      slug: 'example',
      ...overrides,
    }
  }

  it('preserves an edited masked password by submitting undefined', () => {
    const payload = normalizeLinkFormSubmitPayload(formValues({
      password: `${LINK_PASSWORD_MASK_PREFIX}•••ret`,
    }), true)

    expect(payload.password).toBeUndefined()
  })

  it('submits an explicit replacement password', () => {
    const payload = normalizeLinkFormSubmitPayload(formValues({ password: 'replacement' }), true)

    expect(payload.password).toBe('replacement')
  })

  it('clears an existing password with an empty string', () => {
    const payload = normalizeLinkFormSubmitPayload(formValues({ password: '' }), true)

    expect(payload.password).toBe('')
  })

  it('omits an empty password when creating a link', () => {
    const payload = normalizeLinkFormSubmitPayload(formValues({ password: '' }), false)

    expect(payload.password).toBeUndefined()
  })

  it('passes proxy and cloaking through untouched; exclusivity belongs to the visible switches', () => {
    expect(normalizeLinkFormSubmitPayload(formValues({ proxy: true, cloaking: true }), true))
      .toMatchObject({ proxy: true, cloaking: true })
    expect(normalizeLinkFormSubmitPayload(formValues({ cloaking: true }), false))
      .toMatchObject({ cloaking: true, proxy: false })
  })

  it('normalizes geo rows into the current record representation', () => {
    const payload = normalizeLinkFormSubmitPayload(formValues({
      geo: [
        { country: ' us ', url: ' https://first.example.com ' },
        { country: '', url: 'https://missing-country.example.com' },
        { country: 'ca', url: '   ' },
        { country: 'US', url: 'https://last.example.com' },
      ],
    }), false)

    expect(payload.geo).toEqual({ US: 'https://last.example.com' })
    expect(normalizeLinkFormSubmitPayload(formValues(), false).geo).toBeUndefined()
  })

  it('keeps expiration, optional field, and unsafe submission semantics', () => {
    const expiration = new CalendarDate(2030, 1, 2)
    const createPayload = normalizeLinkFormSubmitPayload(formValues({
      comment: '',
      google: '   ',
      apple: '',
      title: '',
      description: '',
      image: '',
      expiration,
      unsafe: false,
    }), false)
    const expectedExpiration = Math.floor(new Date(2030, 0, 2, 23, 59, 59).getTime() / 1000)

    expect(createPayload).toMatchObject({
      comment: undefined,
      google: '   ',
      apple: undefined,
      title: undefined,
      description: undefined,
      image: undefined,
      expiration: expectedExpiration,
      unsafe: undefined,
    })
    expect(normalizeLinkFormSubmitPayload(formValues({ unsafe: false }), true).unsafe).toBe(false)
    expect(normalizeLinkFormSubmitPayload(formValues(), false).expiration).toBeUndefined()
  })
})

describe('link slug validation', () => {
  const pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i

  it.each(['abc', 'my-link', 'My-Link-2', '  padded  '])('accepts %j', (slug) => {
    expect(getLinkSlugValidationError(slug, pattern)).toBeUndefined()
  })

  it.each(['', '   ', undefined, 42])('reports %j as required', (slug) => {
    expect(getLinkSlugValidationError(slug, pattern)).toEqual({ kind: 'required' })
  })

  it.each(['my_link', 'my link', 'a.b', '/abc', 'abc-', '-abc', 'a--b', 'café'])('reports %j as invalid', (slug) => {
    expect(getLinkSlugValidationError(slug, pattern)).toEqual({ kind: 'invalid' })
  })

  it('reports a slug over 2048 characters as too long', () => {
    expect(getLinkSlugValidationError('a'.repeat(2049), pattern)).toEqual({ kind: 'too_long' })
    expect(getLinkSlugValidationError('a'.repeat(2048), pattern)).toBeUndefined()
  })
})
