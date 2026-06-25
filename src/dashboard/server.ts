/**
 * Dashboard HTTP server for the dcr-mcp-agent.
 *
 * Provides a simple web UI to start agent runs, view history, and see results.
 *
 * Routes:
 *   GET  /              → serves the dashboard HTML page
 *   GET  /api/tools     → discovers available MCP tools (via tools/list)
 *   POST /api/agents    → starts a new agent run { toolName, args }
 *   GET  /api/agents    → returns all run records (in-memory)
 */

// Must be imported first: disables TLS verification for ALL HTTPS requests.
import "../util/insecureTls.js";

import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError } from "../config/index.js";
import { Agent } from "../agent/agent.js";
import { connectMcp } from "../mcp/client.js";
import { listTools } from "../mcp/tasks.js";
import { requestToken, selectAuthMethod } from "../oauth/token.js";
import { discoverMetadata } from "../oauth/discovery.js";
import { registerClient } from "../oauth/dcr.js";
import {
  loadCredentials,
  saveCredentials,
  areCredentialsValid,
} from "../oauth/credentialsStore.js";
import { logger } from "../util/logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type RunStatus = "running" | "succeeded" | "failed";

export interface RunRecord {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  status: RunStatus;
  startedAt: string;
  stoppedAt?: string;
  result?: unknown;
  error?: string;
}

// ── In-memory store ──────────────────────────────────────────────────────────

const runs: RunRecord[] = [];
let runCounter = 0;

function newRunId(): string {
  return `run-${String(++runCounter).padStart(4, "0")}`;
}

// ── Config ───────────────────────────────────────────────────────────────────

let baseConfig: ReturnType<typeof loadConfig>;
try {
  baseConfig = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[dashboard] Configuration error: ${(err as Error).message}`);
    process.exit(2);
  }
  throw err;
}

const PORT = parseInt(process.env["DASHBOARD_PORT"] ?? "3000", 10);

// ── Static file helper ───────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

function serveStatic(res: http.ServerResponse, filePath: string): void {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const ext = path.extname(filePath);
    const mime: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css",
      ".js": "application/javascript",
    };
    res.writeHead(200, { "Content-Type": mime[ext] ?? "text/plain" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ── JSON helpers ─────────────────────────────────────────────────────────────

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ── Tool discovery ────────────────────────────────────────────────────────────

const FALLBACK_TOOLS = ["add", "subtract", "multiply", "divide"];

async function discoverMcpTools(): Promise<string[]> {
  try {
    // We need a token first to talk to the MCP server
    const metadata = await discoverMetadata(baseConfig);
    const authMethod = selectAuthMethod(metadata.tokenEndpointAuthMethodsSupported);

    let creds = await loadCredentials(baseConfig.clientCredentialsPath);
    if (!areCredentialsValid(creds)) {
      creds = await registerClient(
        metadata.registrationEndpoint,
        metadata.tokenEndpoint,
        baseConfig,
      );
      await saveCredentials(baseConfig.clientCredentialsPath, creds);
    }

    const token = await requestToken(metadata.tokenEndpoint, creds!, {
      scope: baseConfig.scope,
      authMethod,
    });

    const conn = await connectMcp(baseConfig.mcpServerUrl, token.accessToken);
    try {
      return await listTools(conn.client);
    } finally {
      await conn.close();
    }
  } catch (err) {
    logger.warn("Tool discovery failed; returning fallback list", {
      error: (err as Error).message,
    });
    return FALLBACK_TOOLS;
  }
}

// ── Agent runner ─────────────────────────────────────────────────────────────

async function startAgentRun(
  toolName: string,
  args: Record<string, unknown>,
): Promise<RunRecord> {
  const record: RunRecord = {
    id: newRunId(),
    toolName,
    args,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  runs.unshift(record); // newest first

  // Run asynchronously — don't await here, the HTTP response returns immediately
  (async () => {
    logger.info("Dashboard: starting agent run", { id: record.id, toolName, args });
    try {
      const config = { ...baseConfig, mcpToolName: toolName, mcpToolArgs: args };
      const agent = new Agent(config);
      const result = await agent.runTask();

      record.status = result.isError ? "failed" : "succeeded";
      record.result = result.result;
      if (result.isError) {
        record.error = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
      }
    } catch (err) {
      record.status = "failed";
      record.error = (err as Error).message ?? String(err);
    } finally {
      record.stoppedAt = new Date().toISOString();
      logger.info("Dashboard: agent run completed", {
        id: record.id,
        status: record.status,
      });
    }
  })();

  return record;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    res.end();
    return;
  }

  // ── GET / → serve dashboard HTML
  if (method === "GET" && (url === "/" || url === "/index.html")) {
    serveStatic(res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }

  // ── Static assets (css, js if needed)
  if (method === "GET" && url.startsWith("/public/")) {
    serveStatic(res, path.join(PUBLIC_DIR, url.replace("/public/", "")));
    return;
  }

  // ── GET /api/tools
  if (method === "GET" && url === "/api/tools") {
    const tools = await discoverMcpTools();
    jsonResponse(res, 200, { tools });
    return;
  }

  // ── GET /api/agents
  if (method === "GET" && url === "/api/agents") {
    jsonResponse(res, 200, { runs });
    return;
  }

  // ── POST /api/agents
  if (method === "POST" && url === "/api/agents") {
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch {
      jsonResponse(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const { toolName, args } = body as { toolName?: string; args?: Record<string, unknown> };
    if (!toolName || typeof toolName !== "string") {
      jsonResponse(res, 400, { error: "toolName (string) is required" });
      return;
    }
    const toolArgs: Record<string, unknown> = args && typeof args === "object" ? args : {};

    const record = await startAgentRun(toolName, toolArgs);
    jsonResponse(res, 202, record);
    return;
  }

  // ── 404
  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  logger.info(`Dashboard running at http://localhost:${PORT}`);
  console.log(`\n🚀  Agent Dashboard: http://localhost:${PORT}\n`);
});
