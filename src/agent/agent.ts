/**
 * High-level agent: wires OAuth (discovery + DCR + token) and MCP together.
 *
 * Implements the full flow from CLAUDE.md:
 *   1. Discover AS metadata (RFC 8414)
 *   2. Dynamic Client Registration (RFC 7591), with credential caching
 *   3. Token acquisition (RFC 6749 client_credentials)
 *   4. MCP task execution (tools/list + tools/call)
 *
 * Error handling follows the CLAUDE.md table: re-register once on
 * invalid_client / expired secret, transparently refresh tokens and retry the
 * MCP call once on 401 / invalid_token.
 */

import type { AppConfig } from "../config/index.js";
import { logger } from "../util/logger.js";
import { discoverMetadata, type AsMetadata } from "../oauth/discovery.js";
import { registerClient, DcrError } from "../oauth/dcr.js";
import {
  loadCredentials,
  saveCredentials,
  areCredentialsValid,
  type ClientCredentials,
} from "../oauth/credentialsStore.js";
import {
  requestToken,
  selectAuthMethod,
  TokenError,
  type AccessToken,
} from "../oauth/token.js";
import { connectMcp, McpUnauthorizedError } from "../mcp/client.js";
import { listTools, callTool, type ToolCallResult } from "../mcp/tasks.js";

export class Agent {
  private metadata?: AsMetadata;

  constructor(private readonly config: AppConfig) {}

  /**
   * Ensure we have AS metadata (discover once, then cache for the run).
   */
  private async ensureMetadata(): Promise<AsMetadata> {
    if (!this.metadata) {
      this.metadata = await discoverMetadata(this.config);
    }
    return this.metadata;
  }

  /**
   * Get usable client credentials: load from cache if valid, otherwise
   * register via DCR and persist them.
   */
  private async ensureCredentials(forceReregister = false): Promise<ClientCredentials> {
    const cached = forceReregister
      ? null
      : await loadCredentials(this.config.clientCredentialsPath);

    if (areCredentialsValid(cached)) {
      logger.info("Using cached DCR credentials", { clientId: cached!.clientId });
      return cached!;
    }

    const metadata = await this.ensureMetadata();
    // Two-step DCR: Step 1 mints an IAT at the token endpoint, Step 2 registers
    // the client at the registration endpoint using that IAT as a Bearer token.
    const creds = await registerClient(
      metadata.registrationEndpoint,
      metadata.tokenEndpoint,
      this.config,
    );
    await saveCredentials(this.config.clientCredentialsPath, creds);

    return creds;
  }

  /**
   * Acquire an access token, re-registering once on invalid_client.
   */
  private async acquireToken(): Promise<AccessToken> {
    const metadata = await this.ensureMetadata();
    const authMethod = selectAuthMethod(metadata.tokenEndpointAuthMethodsSupported);

    let creds = await this.ensureCredentials();
    try {
      return await requestToken(
        metadata.tokenEndpoint,
        creds,
        { scope: this.config.scope, authMethod },
      );
    } catch (err) {
      const isInvalidClient =
        err instanceof TokenError && (err.oauthError === "invalid_client" || err.status === 401);
      if (!isInvalidClient) throw err;

      logger.warn("Token request returned invalid_client; re-registering once");
      creds = await this.ensureCredentials(true);
      return await requestToken(
        metadata.tokenEndpoint,
        creds,
        { scope: this.config.scope, authMethod },
      );
    }
  }

  /**
   * Run the configured MCP task end-to-end. Retries once on an MCP 401 by
   * re-acquiring a fresh token.
   */
  async runTask(): Promise<ToolCallResult> {
    let token = await this.acquireToken();

    try {
      return await this.executeMcpTask(token.accessToken);
    } catch (err) {
      if (err instanceof McpUnauthorizedError) {
        logger.warn("MCP returned 401; re-acquiring token and retrying once");
        token = await this.acquireToken();
        return await this.executeMcpTask(token.accessToken);
      }
      throw err;
    }
  }

  /**
   * Connect to MCP, list tools, and invoke the configured tool.
   */
  private async executeMcpTask(accessToken: string): Promise<ToolCallResult> {
    const conn = await connectMcp(this.config.mcpServerUrl, accessToken);
    try {
      const tools = await listTools(conn.client);
      if (!tools.includes(this.config.mcpToolName)) {
        logger.warn("Configured tool not advertised by server", {
          toolName: this.config.mcpToolName,
          available: tools,
        });
      }
      return await callTool(conn.client, this.config.mcpToolName, this.config.mcpToolArgs);
    } finally {
      await conn.close();
    }
  }
}

export { DcrError, TokenError };
