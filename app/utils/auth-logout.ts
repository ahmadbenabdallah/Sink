import type { AuthMethod } from '#shared/types/auth'

interface LogoutSession {
  authMethod: AuthMethod | null
  accessEnabled: boolean
}

/**
 * True when logging out must also end the Cloudflare Access session. A session
 * with no known method only counts as an Access session when Access is enabled;
 * otherwise `/cdn-cgi/access/logout` does not exist on the instance.
 */
export function shouldLogoutCloudflareAccess({ authMethod, accessEnabled }: LogoutSession): boolean {
  return accessEnabled || authMethod === 'access-user' || authMethod === 'access-service'
}
