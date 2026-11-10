import { describe, expect, it } from 'vitest'
import { shouldLogoutCloudflareAccess } from '../../app/utils/auth-logout'

describe('shouldLogoutCloudflareAccess', () => {
  it.each([
    // An unknown session on an instance without Cloudflare Access must go to the login page.
    { authMethod: null, accessEnabled: false, want: false },
    { authMethod: 'site-token', accessEnabled: false, want: false },
    { authMethod: null, accessEnabled: true, want: true },
    { authMethod: 'site-token', accessEnabled: true, want: true },
    { authMethod: 'access-user', accessEnabled: false, want: true },
    { authMethod: 'access-service', accessEnabled: false, want: true },
  ] as const)('authMethod=$authMethod accessEnabled=$accessEnabled -> $want', ({ want, ...session }) => {
    expect(shouldLogoutCloudflareAccess(session)).toBe(want)
  })
})
