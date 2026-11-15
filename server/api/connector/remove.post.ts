import type { ConnectorRemoveResponse } from '#shared/types/connector'
import { RemoveConnectorSchema } from '#shared/schemas/connector'
import { removeToken } from '../../services/mcp/tokens'

defineRouteMeta({
  openAPI: {
    description: 'Remove an MCP connector, active or revoked. Its token is refused from the next request on, and it no longer appears anywhere in the app. The record is kept for the logs. Not available to a connector token.',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', description: 'The id of the connector to remove.' },
            },
          },
        },
      },
    },
  },
})

export default eventHandler(async (event): Promise<ConnectorRemoveResponse> => {
  assertConnectorManager(event)
  assertConnectorChangesAllowed(event)
  assertJsonBody(event)
  const { id } = await readValidatedBody(event, RemoveConnectorSchema.parse)

  const removed = await removeToken(useConnectorDatabase(event), id)
  if (!removed)
    throw connectorNotFound()

  console.log({ event: 'connector.removed', id, authMethod: event.context.authMethod })
  return removed
})
