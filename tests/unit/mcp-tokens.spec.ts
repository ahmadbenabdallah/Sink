import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpTokens } from '../../server/database/schema'
import { createToken, findActiveToken, generateToken, hashToken, listTokens, MCP_TOKEN_PREFIX, revokeToken } from '../../server/services/mcp/tokens'
import { db } from '../utils'

/**
 * A stand-in for the database that answers the lookup query with fixed rows,
 * or fails it, and counts how often it was asked.
 */
function fakeDatabase(answer: unknown[] | Error) {
  let queries = 0
  const query = {
    from: () => query,
    where: () => query,
    limit: async () => {
      queries++
      if (answer instanceof Error)
        throw answer
      return answer
    },
  }
  return { db: { select: () => query } as unknown as DrizzleD1Database, queries: () => queries }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('generateToken', () => {
  it('returns the prefix followed by 32 random bytes in base64url', () => {
    const token = generateToken()
    expect(token).toMatch(/^sink_mcp_[\w-]{43}$/)
    expect(token.startsWith(MCP_TOKEN_PREFIX)).toBe(true)
  })

  it('returns a different token each time', () => {
    expect(generateToken()).not.toBe(generateToken())
  })
})

describe('hashToken', () => {
  it('returns the SHA-256 of the token as 64 hex characters', async () => {
    // The known SHA-256 of "abc".
    expect(await hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('the token store', () => {
  it('stores the hash and a hint, never the token', async () => {
    const { token, connector } = await createToken(db, { name: 'Store test', level: 'create' })

    const [row] = await db.select().from(mcpTokens).where(eq(mcpTokens.id, connector.id))
    expect(row).toMatchObject({ name: 'Store test', level: 'create', revokedAt: null })
    expect(row!.tokenHash).toBe(await hashToken(token))
    expect(row!.hint).toBe(token.slice(MCP_TOKEN_PREFIX.length, MCP_TOKEN_PREFIX.length + 6))
    expect(JSON.stringify(row)).not.toContain(token)
    expect(JSON.stringify(connector)).not.toContain(token)
    expect(connector).not.toHaveProperty('tokenHash')
  })

  it('finds an active token and returns who it belongs to', async () => {
    const { token, connector } = await createToken(db, { name: 'Lookup test', level: 'read' })
    expect(await findActiveToken(db, token)).toEqual({ id: connector.id, name: 'Lookup test', level: 'read' })
  })

  it('finds nothing for a token that was never issued', async () => {
    expect(await findActiveToken(db, `sink_mcp_${'B'.repeat(43)}`)).toBeNull()
  })

  // Anything that is not shaped like a token is refused without a query, so a
  // caller cannot make the database work by sending junk behind the prefix.
  it.each([
    ['a value without the prefix', 'not-a-connector-token'],
    ['an empty value', ''],
    ['the prefix alone', 'sink_mcp_'],
    ['a token one character short', `sink_mcp_${'B'.repeat(42)}`],
    ['a token one character long', `sink_mcp_${'B'.repeat(44)}`],
    ['a token with a character outside base64url', `sink_mcp_${'B'.repeat(42)}+`],
  ])('finds nothing for %s without asking the database', async (_label, value) => {
    const fake = fakeDatabase([{ id: 'x', name: 'x', level: 'full' }])
    expect(await findActiveToken(fake.db, value)).toBeNull()
    expect(fake.queries()).toBe(0)
  })

  it('finds nothing once the token is revoked, and keeps the row', async () => {
    const { token, connector } = await createToken(db, { name: 'Revoke test', level: 'full' })

    const revoked = await revokeToken(db, connector.id)
    expect(revoked?.revokedAt).toEqual(expect.any(Number))
    expect(await findActiveToken(db, token)).toBeNull()

    const again = await revokeToken(db, connector.id)
    expect(again?.revokedAt).toBe(revoked?.revokedAt)

    expect((await listTokens(db)).find(row => row.id === connector.id)?.revokedAt).toBe(revoked?.revokedAt)
  })

  it('returns nothing when revoking an id that does not exist', async () => {
    expect(await revokeToken(db, 'no-such-id')).toBeNull()
  })

  // A level this code does not know must never authenticate: the tool filter
  // could not place it.
  it.each(['admin', 'READ', ''])('finds nothing for a stored token whose level is %j', async (level) => {
    const fake = fakeDatabase([{ id: 'odd', name: 'Odd level', level }])
    expect(await findActiveToken(fake.db, generateToken())).toBeNull()
    expect(fake.queries()).toBe(1)
  })

  it('refuses to store a level outside the three known ones', async () => {
    const row = { id: `bad-${crypto.randomUUID().slice(0, 8)}`, name: 'Bad level', tokenHash: await hashToken(generateToken()), hint: 'abcdef', level: 'admin', createdAt: 1, revokedAt: null }
    await expect(db.insert(mcpTokens).values(row as unknown as typeof mcpTokens.$inferInsert)).rejects.toThrow()
  })

  it('refuses to store the same token twice', async () => {
    const tokenHash = await hashToken(generateToken())
    const row = { name: 'Duplicate', tokenHash, hint: 'abcdef', level: 'read' as const, createdAt: 1, revokedAt: null }
    await db.insert(mcpTokens).values({ ...row, id: `dup-${crypto.randomUUID().slice(0, 8)}` })
    await expect(db.insert(mcpTokens).values({ ...row, id: `dup-${crypto.randomUUID().slice(0, 8)}` })).rejects.toThrow()
  })

  // A database fault, or the table missing before its migration has run, must
  // read as "not a valid token", never as an error that reaches the caller.
  // The log has to say why, without the query text, which holds the hash.
  it('finds nothing when the database fails, and logs the cause without the query', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const token = generateToken()
    const failure = new Error(`Failed query: select ... where token_hash = ${await hashToken(token)}`, {
      cause: new Error('D1_ERROR: no such table: mcp_tokens'),
    })

    expect(await findActiveToken(fakeDatabase(failure).db, token)).toBeNull()

    expect(error).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      event: 'mcp_token.lookup_failed',
      cause: 'D1_ERROR: no such table: mcp_tokens',
    }))
    expect(JSON.stringify(error.mock.calls)).not.toContain(await hashToken(token))
    expect(JSON.stringify(error.mock.calls)).not.toContain(token)
  })

  it('lists tokens newest first, in the order they were created, without their hashes', async () => {
    const created = []
    for (const name of ['List test 1', 'List test 2', 'List test 3'])
      created.push(await createToken(db, { name, level: 'read' }))

    const rows = await listTokens(db)
    const positions = created.map(({ connector }) => rows.findIndex(row => row.id === connector.id))
    expect(positions[2]).toBeLessThan(positions[1]!)
    expect(positions[1]).toBeLessThan(positions[0]!)

    expect(rows[positions[0]!]).not.toHaveProperty('tokenHash')
    expect(JSON.stringify(rows)).not.toContain(created[0]!.token)
  })
})
