declare module 'h3' {
  interface H3EventContext {
    authMethod?: import('./auth').AuthMethod
    userID?: string
    userEmail?: string
    /** Set by the auth middleware on the MCP route only. */
    mcpCaller?: import('./auth').McpCaller
    cloudflare: {
      request: Request<unknown, IncomingRequestCfProperties>
      env: Cloudflare.Env
      context: ExecutionContext
    }
  }
}

export {}
