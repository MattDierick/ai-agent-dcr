/**
 * Entry point / CLI for the dcr-mcp-agent.
 *
 * Loads configuration from the environment, runs the full
 * DCR -> token -> MCP tool-call flow, and prints the structured result.
 *
 * By default it invokes the MCP "add" tool with { a: 9, b: 7 } (=> 16),
 * matching the demo tools/call payload. Override via MCP_TOOL_NAME /
 * MCP_TOOL_ARGS environment variables.
 */

// Must be imported first: disables TLS verification for ALL HTTPS requests
// (AS and MCP servers use unsigned certificates). See the module for details.
import "./util/insecureTls.js";

import { loadConfig, ConfigError } from "./config/index.js";

import { Agent } from "./agent/agent.js";
import { logger } from "./util/logger.js";

async function main(): Promise<void> {
  // Allow tool name and args to be passed as positional CLI arguments:
  //   node --env-file=.env --import tsx src/index.ts <toolName> <argsJSON>
  // e.g.: node --env-file=.env --import tsx src/index.ts add '{"a":7,"b":11}'
  const [,, cliToolName, cliToolArgs] = process.argv;
  if (cliToolName) process.env["MCP_TOOL_NAME"] = cliToolName;
  if (cliToolArgs) process.env["MCP_TOOL_ARGS"] = cliToolArgs;

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error("Configuration error", { message: err.message });
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  logger.info("Starting dcr-mcp-agent", {
    asIssuer: config.oauthAsIssuer,
    mcpServerUrl: config.mcpServerUrl,
    toolName: config.mcpToolName,
    toolArgs: config.mcpToolArgs,
  });

  const agent = new Agent(config);

  try {
    const result = await agent.runTask();

    // Print the structured tool result to stdout.
    console.log("\n=== MCP tool result ===");
    console.log(JSON.stringify(result, null, 2));

    if (result.isError) {
      logger.error("Tool returned an error result", { toolName: result.toolName });
      process.exitCode = 1;
    } else {
      logger.info("Task completed successfully", { toolName: result.toolName });
    }
  } catch (err) {
    logger.error("Task failed", { error: (err as Error).message });
    process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error("Unhandled error", { error: (err as Error).message ?? String(err) });
  process.exitCode = 1;
});
