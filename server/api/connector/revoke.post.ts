import type { ConnectorRevokeResponse } from '#shared/types/connector'
import { RevokeConnectorSchema } from '#shared/schemas/connector'
import { revokeToken } from '../../services/mcp/tokens'

defineRouteMeta({
  openAPI: {
    description: 'Revoke an MCP connector. Its token is refused from the next request on. Revoking it again changes nothing. A removed or unknown connector answers 404. Not available to a connector token.',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', description: 'The id of the connector to revoke.' },
            },
          },
        },
      },
    },
  },
})

export default eventHandler(async (event): Promise<ConnectorRevokeResponse> => {
  assertConnectorManager(event)
  assertConnectorChangesAllowed(event)
  assertJsonBody(event)
  const { id } = await readValidatedBody(event, RevokeConnectorSchema.parse)

  const connector = await revokeToken(useConnectorDatabase(event), id)
  if (connector?.revokedAt == null)
    throw connectorNotFound()

  console.log({ event: 'connector.revoked', id: connector.id, authMethod: event.context.authMethod })
  return { id: connector.id, revokedAt: connector.revokedAt }
})
