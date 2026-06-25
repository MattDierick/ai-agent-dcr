/**
 * Configuration loading & validation.
 *
 * All configuration comes from environment variables (see .env.example).
 * URLs and secrets are NEVER hardcoded — the OAuth AS issuer and MCP server
 * URL must be provided via the environment before running the agent.
 */

export interface AppConfig {
  /** Base issuer URL of the OAuth AS (required). */
  oauthAsIssuer: string;
  /** Explicit DCR endpoint override (optional; else discovered). */
  registrationEndpoint?: string;
  /** Explicit token endpoint override (optional; else discovered). */
  tokenEndpoint?: string;
  /** Initial access token for DCR, if the AS requires one (optional). */
  initialAccessToken?: string;
  /** IAT client ID used for HTTP Basic auth on the DCR request (required for DCR). */
  dcrClientId?: string;
  /** IAT client secret used for HTTP Basic auth on the DCR request (required for DCR). */
  dcrClientSecret?: string;
  /** Scope sent in the DCR request body. Defaults to "scope-client-ai". */
  dcrScope: string;
  /** Space-separated scopes to request (optional). */
  scope?: string;

  /** URL of the MCP server (required). */
  mcpServerUrl: string;
  /** Tool name to invoke. Defaults to the demo "add" tool. */
  mcpToolName: string;
  /** Arguments for the tool. Defaults to { a: 9, b: 7 }. */
  mcpToolArgs: Record<string, unknown>;
  /** File path to cache DCR credentials. */
  clientCredentialsPath: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new ConfigError(
      `Missing required environment variable: ${name}. ` +
        `Set it before running the agent (see .env.example).`,
    );
  }
  return value.trim();
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value || value.trim() === "") return undefined;
  return value.trim();
}

/**
 * Reject plaintext HTTP except for localhost (CLAUDE.md security requirement).
 */
function assertSecureUrl(label: string, raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${label} is not a valid URL: ${raw}`);
  }
  const isLocalhost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol === "http:" && !isLocalhost) {
    throw new ConfigError(
      `${label} must use HTTPS (got ${url.protocol}//). ` +
        `Plaintext HTTP is only allowed for localhost.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${label} must use http(s): ${raw}`);
  }
}

/**
 * Parse the tool arguments JSON, defaulting to the demo "add" payload.
 */
function parseToolArgs(): Record<string, unknown> {
  const raw = optionalEnv("MCP_TOOL_ARGS");
  if (!raw) {
    // Default demo payload: add(9, 7) => 16
    return { a: 9, b: 7 };
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(
      `MCP_TOOL_ARGS must be a JSON object, e.g. {"a":9,"b":7}. ` +
        `Parse error: ${(err as Error).message}`,
    );
  }
}

/**
 * Load and validate configuration from the environment.
 * Throws ConfigError if required values are missing or invalid.
 */
export function loadConfig(): AppConfig {
  const oauthAsIssuer = requireEnv("OAUTH_AS_ISSUER");
  const mcpServerUrl = requireEnv("MCP_SERVER_URL");

  assertSecureUrl("OAUTH_AS_ISSUER", oauthAsIssuer);
  assertSecureUrl("MCP_SERVER_URL", mcpServerUrl);

  const registrationEndpoint = optionalEnv("OAUTH_REGISTRATION_ENDPOINT");
  if (registrationEndpoint) assertSecureUrl("OAUTH_REGISTRATION_ENDPOINT", registrationEndpoint);

  const tokenEndpoint = optionalEnv("OAUTH_TOKEN_ENDPOINT");
  if (tokenEndpoint) assertSecureUrl("OAUTH_TOKEN_ENDPOINT", tokenEndpoint);

  return {
    oauthAsIssuer: oauthAsIssuer.replace(/\/+$/, ""),
    registrationEndpoint,
    tokenEndpoint,
    initialAccessToken: optionalEnv("OAUTH_INITIAL_ACCESS_TOKEN"),
    dcrClientId: optionalEnv("DCR_CLIENT_ID"),
    dcrClientSecret: optionalEnv("DCR_CLIENT_SECRET"),
    dcrScope: optionalEnv("DCR_SCOPE") ?? "scope-client-ai",
    scope: optionalEnv("OAUTH_SCOPE"),

    mcpServerUrl,
    mcpToolName: optionalEnv("MCP_TOOL_NAME") ?? "add",
    mcpToolArgs: parseToolArgs(),
    clientCredentialsPath: optionalEnv("CLIENT_CREDENTIALS_PATH") ?? ".dcr-credentials.json",
  };
}
