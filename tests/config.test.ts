import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, ConfigError } from "../src/config/index.js";

const SAVED = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OAUTH_") || key.startsWith("MCP_") || key === "CLIENT_CREDENTIALS_PATH") {
      delete process.env[key];
    }
  }
}

describe("loadConfig", () => {
  beforeEach(() => resetEnv());
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it("throws when OAUTH_AS_ISSUER is missing", () => {
    process.env.MCP_SERVER_URL = "https://mcp.example.com";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("throws when MCP_SERVER_URL is missing", () => {
    process.env.OAUTH_AS_ISSUER = "https://as.example.com";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("defaults the tool to add with a=9 b=7", () => {
    process.env.OAUTH_AS_ISSUER = "https://as.example.com";
    process.env.MCP_SERVER_URL = "https://mcp.example.com";
    const cfg = loadConfig();
    expect(cfg.mcpToolName).toBe("add");
    expect(cfg.mcpToolArgs).toEqual({ a: 9, b: 7 });
  });

  it("strips trailing slash from issuer", () => {
    process.env.OAUTH_AS_ISSUER = "https://as.example.com/";
    process.env.MCP_SERVER_URL = "https://mcp.example.com";
    expect(loadConfig().oauthAsIssuer).toBe("https://as.example.com");
  });

  it("rejects plaintext http for non-localhost", () => {
    process.env.OAUTH_AS_ISSUER = "http://as.example.com";
    process.env.MCP_SERVER_URL = "https://mcp.example.com";
    expect(() => loadConfig()).toThrow(/HTTPS/);
  });

  it("allows http for localhost", () => {
    process.env.OAUTH_AS_ISSUER = "http://localhost:8080";
    process.env.MCP_SERVER_URL = "http://localhost:3000/mcp";
    expect(() => loadConfig()).not.toThrow();
  });

  it("parses MCP_TOOL_ARGS JSON", () => {
    process.env.OAUTH_AS_ISSUER = "https://as.example.com";
    process.env.MCP_SERVER_URL = "https://mcp.example.com";
    process.env.MCP_TOOL_ARGS = '{"a":1,"b":2}';
    expect(loadConfig().mcpToolArgs).toEqual({ a: 1, b: 2 });
  });

  it("rejects invalid MCP_TOOL_ARGS", () => {
    process.env.OAUTH_AS_ISSUER = "https://as.example.com";
    process.env.MCP_SERVER_URL = "https://mcp.example.com";
    process.env.MCP_TOOL_ARGS = "not-json";
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});
