import { describe, expect, it, vi } from 'vitest'
import { hashLinkPassword, verifyLinkPassword } from '../../server/utils/link-password'

vi.mock('#shared/utils/link-password', async () => import('../../shared/utils/link-password'))

// These pin the true/false result of the legacy plaintext path. They do not
// (and cannot) measure whether the comparison is constant-time.
describe('verifyLinkPassword with a legacy plaintext stored password', () => {
  it.each([
    ['equal', 'secret', 'secret', true],
    ['different, same length', 'secret', 'secreT', false],
    ['different length', 'secret', 'secrets!', false],
    ['input is a prefix of stored', 'sec', 'secret', false],
    ['stored is a prefix of input', 'secret', 'sec', false],
    ['empty input, non-empty stored', '', 'secret', false],
    ['non-empty input, empty stored', 'secret', '', false],
    ['both empty', '', '', true],
    ['non-ASCII equal', 'pässwörd-密码-🔑', 'pässwörd-密码-🔑', true],
    ['non-ASCII different', 'pässwörd-密码-🔑', 'pässwörd-密码-🔒', false],
    ['same text in NFC and NFD', 'é', 'é', false],
    ['different lone surrogates', '\uD800', '\uD801', false],
    ['equal lone surrogates', '\uD800', '\uD800', true],
    ['malformed hash prefix, equal', 'sink-pwd:v1:garbage', 'sink-pwd:v1:garbage', true],
    ['malformed hash prefix, different', 'garbage', 'sink-pwd:v1:garbage', false],
    ['malformed hash, non-numeric iterations', 'secret', 'sink-pwd:v1:x:c2FsdA:aGFzaA:dGFpbA', false],
  ])('%s', async (_name, input, stored, expected) => {
    expect(await verifyLinkPassword(input, stored)).toBe(expected)
  })
})

describe('verifyLinkPassword with a hashed stored password', () => {
  it('accepts the right password and rejects others', async () => {
    const stored = await hashLinkPassword('pässwörd-🔑')

    expect(await verifyLinkPassword('pässwörd-🔑', stored)).toBe(true)
    expect(await verifyLinkPassword('pässwörd', stored)).toBe(false)
    expect(await verifyLinkPassword(stored, stored)).toBe(false)
  })
})
