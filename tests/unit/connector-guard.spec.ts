import type { H3Event } from 'h3'
import { describe, expect, it } from 'vitest'
import { assertConnectorManager } from '../../server/utils/connector'

function eventWith(authMethod: unknown) {
  return { context: { authMethod } } as unknown as H3Event
}

// The auth middleware already keeps connector tokens off these routes. This
// second check is what stops a connector minting connectors if that ever
// changes, so it is an allowlist: anything it does not recognise is refused.
describe('assertConnectorManager', () => {
  it.each(['site-token', 'access-user', 'access-service'])('lets a caller signed in by %s through', (authMethod) => {
    expect(() => assertConnectorManager(eventWith(authMethod))).not.toThrow()
  })

  it.each(['connector', 'something-new', '', undefined, null])('refuses a caller signed in by %j', (authMethod) => {
    expect(() => assertConnectorManager(eventWith(authMethod))).toThrow(expect.objectContaining({ statusCode: 403 }))
  })
})
