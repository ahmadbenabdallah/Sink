import type { ConnectorCreateResponse } from '#shared/types/connector'
import { CreateConnectorSchema } from '#shared/schemas/connector'
import { createToken } from '../../services/mcp/tokens'

defineRouteMeta({
  openAPI: {
    description: 'Create an MCP connector and return its token. The token is shown in this response only; it cannot be read again. Not available to a connector token.',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name', 'level'],
            properties: {
              name: { type: 'string', description: 'A label to recognise the connector by, for example "Claude Code". 1 to 64 characters.' },
              level: { type: 'string', enum: ['read', 'create', 'full'], description: 'read: links and analytics. create: also create links. full: also change and delete links.' },
            },
          },
        },
      },
    },
  },
})

export default eventHandler(async (event): Promise<ConnectorCreateResponse> => {
  assertConnectorManager(event)
  assertConnectorChangesAllowed(event)
  assertJsonBody(event)
  const input = await readValidatedBody(event, CreateConnectorSchema.parse)

  const { connector, token } = await createToken(useConnectorDatabase(event), input)
  // A connector outlives a change of the site token, so its creation is
  // recorded. Never the token.
  console.log({ event: 'connector.created', id: connector.id, level: connector.level, authMethod: event.context.authMethod })

  // The body holds a credential: no cache or proxy may keep a copy of it.
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseStatus(event, 201)
  return { connector: toConnectorView(connector, NO_USAGE), token }
})
