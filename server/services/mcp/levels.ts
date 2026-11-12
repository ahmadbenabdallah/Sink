import type { McpLevel } from '#shared/types/auth'

/** Each level includes the ones before it. */
const LEVELS: readonly McpLevel[] = ['read', 'create', 'full']

/** Whether a value read from storage or a request is one of the known levels. */
export function isMcpLevel(value: unknown): value is McpLevel {
  return LEVELS.includes(value as McpLevel)
}

/**
 * Whether a caller at `callerLevel` may use a tool that needs `toolLevel`.
 *
 * A level this code does not know, on either side, allows nothing. The check is
 * written as "is the caller's level known and high enough", never as "is the
 * tool above the caller": a missing rank compares false both ways, and the
 * second form would then let every tool through.
 */
export function levelAllows(callerLevel: unknown, toolLevel: McpLevel): boolean {
  return isMcpLevel(callerLevel) && isMcpLevel(toolLevel) && LEVELS.indexOf(callerLevel) >= LEVELS.indexOf(toolLevel)
}
