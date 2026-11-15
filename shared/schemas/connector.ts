import { z } from 'zod'
import { MCP_LEVELS } from '../types/auth'

/** Longest connector name, in characters. The dashboard form validates with the same schema. */
export const CONNECTOR_NAME_MAX_LENGTH = 64

/**
 * A label shown in lists and written to logs. Control and invisible formatting
 * characters are refused: a name must not be blank on screen, break a log line,
 * or reverse the text around it.
 */
export const ConnectorNameSchema = z.string()
  .trim()
  .min(1)
  .max(CONNECTOR_NAME_MAX_LENGTH)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'name must not contain control or invisible characters')

/** POST /api/connector/create. Anything else in the body is dropped: the server sets the id, the token and the times. */
export const CreateConnectorSchema = z.object({
  name: ConnectorNameSchema,
  level: z.enum(MCP_LEVELS),
})

/** A connector id in a request body. */
export const ConnectorIdSchema = z.string().trim().min(1).max(64)

/** POST /api/connector/revoke. */
export const RevokeConnectorSchema = z.object({ id: ConnectorIdSchema })

/** POST /api/connector/rename. The name follows the same rules as on create. */
export const RenameConnectorSchema = z.object({ id: ConnectorIdSchema, name: ConnectorNameSchema })

/** POST /api/connector/rotate. */
export const RotateConnectorSchema = z.object({ id: ConnectorIdSchema })

/** POST /api/connector/remove. */
export const RemoveConnectorSchema = z.object({ id: ConnectorIdSchema })
