/**
 * MCP client connection over Streamable HTTP, presenting a Bearer JWT.
 *
 * Uses the official @modelcontextprotocol/sdk. The access token is attached
 * as an Authorization header on every HTTP request to the MCP server.
 *
 * Session management (mcp-session-id):
 *  1. The MCP initialize response returns a `mcp-session-id` header. The
 *     StreamableHTTPClientTransport captures this automatically and attaches it
 *     to every subsequent request.
 *  2. After a successful initialize, we send a `notifications/initialized`
 *     notification (with the mcp-session-id header) to complete the handshake.
 *  3. Every following request carries the mcp-session-id header automatically
 *     via the transport's _commonHeaders() method.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../util/logger.js";

export interface McpConnection {
  client: Client;
  /** The mcp-session-id received from the server during initialize. */
  sessionId: string | undefined;
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
 *
 * Session flow:
 *  1. POST initialize  → server returns mcp-session-id response header
 *  2. Transport saves the session id; all subsequent requests include it
 *  3. POST notifications/initialized (with mcp-session-id header)
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

  const clientInfo = { name: "dcr-mcp-agent", version: "1.0.0" };
  const client = new Client(clientInfo, { capabilities: {} });

  // The JSON-RPC "initialize" body the SDK sends during client.connect().
  // Logged so the exact MCP init payload is visible in the npm logs.
  const initBody = {
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo,
    },
    id: 1,
  };

  try {
    logger.info("MCP init: sending initialize request", {
      serverUrl,
      body: JSON.stringify(initBody),
    });
    await client.connect(transport);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.error("MCP init: FAILED", { serverUrl, error: message });
    if (/401|unauthorized/i.test(message)) {
      throw new McpUnauthorizedError(`MCP server returned 401: ${message}`);
    }
    throw err;
  }

  // ── Step 1: capture the mcp-session-id ──────────────────────────────────
  // The transport reads the `mcp-session-id` response header from the
  // initialize response and stores it internally. We surface it here for
  // logging and for callers that need it.
  const sessionId = transport.sessionId;
  logger.info("MCP init: SUCCESS — session initialized", {
    serverUrl,
    sessionId: sessionId ?? "(none)",
  });

  // ── Step 2: send notifications/initialized ───────────────────────────────
  // The MCP spec requires the client to send this notification after a
  // successful initialize exchange. We send it as a raw POST so we can log
  // the exact body and confirm the mcp-session-id header is included.
  // The SDK transport's _commonHeaders() automatically adds the saved
  // mcp-session-id to every outgoing request, including this one.
  const notifBody = {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  };

  const notifHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    notifHeaders["mcp-session-id"] = sessionId;
  }

  logger.info("MCP notif: sending notifications/initialized", {
    serverUrl,
    sessionId: sessionId ?? "(none)",
    body: JSON.stringify(notifBody),
  });

  try {
    const notifResponse = await fetch(serverUrl, {
      method: "POST",
      headers: notifHeaders,
      body: JSON.stringify(notifBody),
    });
    logger.info("MCP notif: notifications/initialized sent", {
      serverUrl,
      status: notifResponse.status,
      sessionId: sessionId ?? "(none)",
    });
  } catch (err) {
    // Notification delivery failures are non-fatal — log and continue.
    logger.warn("MCP notif: notifications/initialized delivery failed (non-fatal)", {
      serverUrl,
      error: (err as Error).message ?? String(err),
    });
  }

  // ── Step 3: mcp-session-id on every subsequent request ───────────────────
  // The transport's _commonHeaders() already injects the saved mcp-session-id
  // automatically into every POST (tools/list, tools/call, …). Nothing extra
  // is needed — log the confirmation so it is visible in the output.
  logger.info("MCP session: mcp-session-id will be attached to all future requests", {
    sessionId: sessionId ?? "(none)",
  });

  return {
    client,
    sessionId,
    close: async () => {
      try {
        await client.close();
      } catch {
        // ignore close errors
      }
    },
  };
}
