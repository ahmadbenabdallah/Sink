import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectorSnippets, connectorUsageState, copyToClipboard } from '../../app/utils/connector'

const TOKEN = `sink_mcp_${'A'.repeat(43)}`

describe('connectorSnippets', () => {
  it('builds the Claude Code command for this instance and token', () => {
    expect(connectorSnippets('https://go.example.com', TOKEN).claudeCode)
      .toBe(`claude mcp add --transport http sink https://go.example.com/api/mcp --header "Authorization: Bearer ${TOKEN}"`)
  })

  it('builds a JSON client configuration that parses to the same endpoint and header', () => {
    const { json } = connectorSnippets('https://go.example.com', TOKEN)
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        sink: {
          type: 'http',
          url: 'https://go.example.com/api/mcp',
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      },
    })
    expect(json).toContain('\n')
  })

  it('does not double the slash when the origin ends with one', () => {
    expect(connectorSnippets('https://go.example.com/', TOKEN).claudeCode).toContain(' https://go.example.com/api/mcp ')
  })
})

describe('connectorUsageState', () => {
  // The API reports unreadable usage as null calls, which is not the same as
  // no calls and must not be shown as zero.
  it.each([
    [{ calls7d: null, lastUsedAt: null }, 'unavailable'],
    [{ calls7d: 0, lastUsedAt: null }, 'never'],
    [{ calls7d: 0, lastUsedAt: 1_800_000_000 }, 'used'],
    [{ calls7d: 12, lastUsedAt: 1_800_000_000 }, 'used'],
  ] as const)('reads %j as %s', (usage, state) => {
    expect(connectorUsageState(usage)).toBe(state)
  })
})

describe('copyToClipboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes the text and reports success', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    expect(await copyToClipboard(TOKEN)).toBe(true)
    expect(writeText).toHaveBeenCalledExactlyOnceWith(TOKEN)
  })

  // The page must not say "Copied" when nothing was copied.
  it('reports failure when the browser refuses', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied')
    })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await copyToClipboard(TOKEN)).toBe(false)
  })

  it('reports failure when there is no clipboard', async () => {
    vi.stubGlobal('navigator', {})
    expect(await copyToClipboard(TOKEN)).toBe(false)
  })
})
