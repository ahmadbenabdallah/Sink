import { describe, expect, it } from 'vitest'
import check from '../../i18n/locales/en-US/check.json'
import core from '../../i18n/locales/en-US/core.json'
import { LINK_CHECK_ERROR_CODES } from '../../shared/types/link-check'
import { API_ERROR_CODES } from '../../shared/utils/api-error'

const serverSources = import.meta.glob<string>('../../server/**/*.ts', { query: '?raw', import: 'default', eager: true })
// Codes must be written exactly as `data: { code: '…'` on one line, code first: any other form is
// invisible to this scan and would be shown untranslated.
const usedCodes = new Set(Object.values(serverSources).flatMap(source => [...source.matchAll(/data: \{ code: '([^']+)'/g)].map(match => match[1]!)))

describe('server error codes', () => {
  it('every code attached by the server is declared in the shared list', () => {
    expect([...usedCodes].filter(code => !API_ERROR_CODES.includes(code as never))).toEqual([])
  })

  it('every declared code is used by the server and translated', () => {
    expect([...usedCodes].sort()).toEqual([...API_ERROR_CODES].sort())
    expect(Object.keys(core.errors).sort()).toEqual([...API_ERROR_CODES].sort())
  })

  it('every link-check error code is translated', () => {
    expect(Object.keys(check.check.errors).sort()).toEqual([...LINK_CHECK_ERROR_CODES].sort())
  })
})
