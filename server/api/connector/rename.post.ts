import type { ConnectorRenameResponse } from '#shared/types/connector'
import { RenameConnectorSchema } from '#shared/schemas/connector'
import { renameToken } from '../../services/mcp/tokens'

defineRouteMeta({
  openAPI: {
    description: 'Rename an MCP connector. A revoked connector cannot be renamed (409); a removed or unknown one answers 404. Not available to a connector token.',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['id', 'name'],
            properties: {
              id: { type: 'string', description: 'The id of the connector to rename.' },
              name: { type: 'string', description: 'The new name. 1 to 64 characters, as on create.' },
            },
          },
        },
      },
    },
  },
})

export default eventHandler(async (event): Promise<ConnectorRenameResponse> => {
  assertConnectorManager(event)
  assertConnectorChangesAllowed(event)
  assertJsonBody(event)
  const { id, name } = await readValidatedBody(event, RenameConnectorSchema.parse)
  const db = useConnectorDatabase(event)

  const connector = await renameToken(db, id, name)
  if (!connector)
    throw await connectorUnchangedError(db, id)

  // Never the name: it is the owner's label and may say anything.
  console.log({ event: 'connector.renamed', id, authMethod: event.context.authMethod })
  return { connector: toConnectorView(connector, await connectorUsage(db, id)) }
})
