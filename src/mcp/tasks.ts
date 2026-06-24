/**
 * MCP task orchestration: discover tools and invoke a tool.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { logger } from "../util/logger.js";

export interface ToolCallResult {
  toolName: string;
  /** The raw structured result returned by the MCP server. */
  result: unknown;
  /** Whether the tool reported an error. */
  isError: boolean;
}

/**
 * List the tools advertised by the MCP server.
 */
export async function listTools(client: Client): Promise<string[]> {
  const res = await client.listTools();
  const names = res.tools.map((t) => t.name);
  logger.info("Discovered MCP tools", { tools: names });
  return names;
}

/**
 * Invoke a tool by name with the given arguments (tools/call).
 * Returns the structured result; surfaces tool-reported errors via isError.
 */
export async function callTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  // The JSON-RPC "tools/call" body the SDK sends. Logged so the exact MCP
  // request payload is visible in the npm logs.
  const requestBody = {
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: toolName, arguments: args },
    id: 2,
  };
  logger.info("MCP request: sending tools/call", {
    toolName,
    body: JSON.stringify(requestBody),
  });

  let res;
  try {
    res = await client.callTool({ name: toolName, arguments: args });
  } catch (err) {
    logger.error("MCP request: FAILED", {
      toolName,
      error: (err as Error).message ?? String(err),
    });
    throw err;
  }

  const isError = Boolean((res as { isError?: boolean }).isError);
  if (isError) {
    logger.warn("MCP request: tool reported an error result", { toolName });
  } else {
    logger.info("MCP request: SUCCESS — tools/call completed", { toolName });
  }


  return {
    toolName,
    result: (res as { content?: unknown }).content ?? res,
    isError,
  };
}
