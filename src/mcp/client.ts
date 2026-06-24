/**
 * MCP client connection over Streamable HTTP, presenting a Bearer JWT.
 *
 * Uses the official @modelcontextprotocol/sdk. The access token is attached
 * as an Authorization header on every HTTP request to the MCP server.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../util/logger.js";

export interface McpConnection {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Thrown when the MCP server responds with a 401 challenge so the caller can
 * re-acquire a token and retry (per the MCP OAuth flow / CLAUDE.md table).
 */
export class McpUnauthorizedError extends Error {
  readonly wwwAuthenticate?: string;
  constructor(message: string, wwwAuthenticate?: string) {
    super(message);
    this.name = "McpUnauthorizedError";
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

/**
 * Connect to the MCP server and complete the initialize handshake.
 * The provided accessToken is sent as `Authorization: Bearer <token>`.
 */
export async function connectMcp(serverUrl: string, accessToken: string): Promise<McpConnection> {
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        // The MCP Streamable HTTP transport requires the client to accept BOTH
        // JSON and SSE responses. Some FastMCP servers return 406 Not Acceptable
        // if this is missing, which would break the automatic tools/call flow.
        Accept: "application/json, text/event-stream",
      },
    },
  });


  const client = new Client(
    { name: "dcr-mcp-agent", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    logger.info("Connecting to MCP server", { serverUrl });
    await client.connect(transport);
    logger.info("MCP session initialized");
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (/401|unauthorized/i.test(message)) {
      throw new McpUnauthorizedError(`MCP server returned 401: ${message}`);
    }
    throw err;
  }

  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch {
        // ignore close errors
      }
    },
  };
}
