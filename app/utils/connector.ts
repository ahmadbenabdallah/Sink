import type { ConnectorUsage } from '../../shared/types/connector'

/**
 * How to show a caller's usage. `unavailable` means the server could not read
 * it, which must never be shown as zero calls.
 */
export function connectorUsageState(usage: ConnectorUsage): 'unavailable' | 'never' | 'used' {
  if (usage.calls7d === null)
    return 'unavailable'
  return usage.lastUsedAt === null ? 'never' : 'used'
}

/**
 * Ready-to-paste ways of connecting an agent with a new token: the Claude Code
 * command, and the JSON configuration that other MCP clients take.
 */
export function connectorSnippets(origin: string, token: string): { claudeCode: string, json: string } {
  const url = `${origin.replace(/\/+$/, '')}/api/mcp`
  const authorization = `Bearer ${token}`

  return {
    claudeCode: `claude mcp add --transport http sink ${url} --header "Authorization: ${authorization}"`,
    json: JSON.stringify({ mcpServers: { sink: { type: 'http', url, headers: { Authorization: authorization } } } }, null, 2),
  }
}

/**
 * Copies text and says whether it worked, so the page never claims "Copied"
 * when the browser refused. It keeps no copy of the text itself, which matters
 * for a token that is meant to be shown once.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  }
  catch {
    return false
  }
}
