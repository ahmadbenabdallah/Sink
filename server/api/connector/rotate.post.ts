import type { ConnectorRotateResponse } from '#shared/types/connector'
import { RotateConnectorSchema } from '#shared/schemas/connector'
import { rotateToken } from '../../services/mcp/tokens'

defineRouteMeta({
  openAPI: {
    description: 'Replace an MCP connector\'s token and return the new one. The old token is refused from the next request on; the id, name, level and usage history stay. The new token is shown in this response only. A revoked connector cannot be rotated (409); a removed or unknown one answers 404. Not available to a connector token.',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', description: 'The id of the connector whose token to replace.' },
            },
          },
        },
      },
    },
  },
})

export default eventHandler(async (event): Promise<ConnectorRotateResponse> => {
  assertConnectorManager(event)
  assertConnectorChangesAllowed(event)
  assertJsonBody(event)
  const { id } = await readValidatedBody(event, RotateConnectorSchema.parse)
  const db = useConnectorDatabase(event)

  const rotated = await rotateToken(db, id)
  if (!rotated)
    throw await connectorUnchangedError(db, id)

  // Never the token.
  console.log({ event: 'connector.rotated', id, authMethod: event.context.authMethod })
  // The body holds a credential: no cache or proxy may keep a copy of it.
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return { connector: toConnectorView(rotated.connector, await connectorUsage(db, id)), token: rotated.token }
})
