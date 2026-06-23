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
  logger.info("Calling MCP tool", { toolName, args });
  const res = await client.callTool({ name: toolName, arguments: args });

  const isError = Boolean((res as { isError?: boolean }).isError);
  if (isError) {
    logger.warn("MCP tool reported an error", { toolName });
  } else {
    logger.info("MCP tool call succeeded", { toolName });
  }

  return {
    toolName,
    result: (res as { content?: unknown }).content ?? res,
    isError,
  };
}
