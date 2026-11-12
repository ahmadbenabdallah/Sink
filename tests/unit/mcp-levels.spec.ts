import { describe, expect, it } from 'vitest'
import { isMcpLevel, levelAllows } from '../../server/services/mcp/levels'

describe('levelAllows', () => {
  it.each([
    ['read', 'read', true],
    ['read', 'create', false],
    ['read', 'full', false],
    ['create', 'read', true],
    ['create', 'create', true],
    ['create', 'full', false],
    ['full', 'read', true],
    ['full', 'create', true],
    ['full', 'full', true],
  ] as const)('a %s caller and a %s tool: %s', (caller, tool, allowed) => {
    expect(levelAllows(caller, tool)).toBe(allowed)
  })

  // A level this code does not know must get nothing. A comparison of ranks
  // that are missing is always false, so "is the tool above the caller" would
  // let every tool through.
  it.each(['admin', 'READ', 'Full', '', 'constructor', '__proto__', undefined, null, 2])('allows a caller with the unknown level %j nothing', (level) => {
    for (const tool of ['read', 'create', 'full'] as const)
      expect(levelAllows(level, tool)).toBe(false)
  })

  it('allows nothing for a tool whose level is unknown', () => {
    expect(levelAllows('full', 'admin' as never)).toBe(false)
  })
})

describe('isMcpLevel', () => {
  it.each(['read', 'create', 'full'])('accepts %s', (level) => {
    expect(isMcpLevel(level)).toBe(true)
  })

  it.each(['admin', 'READ', '', 'constructor', undefined, null, 0])('rejects %j', (level) => {
    expect(isMcpLevel(level)).toBe(false)
  })
})
