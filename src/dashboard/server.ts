/**
 * Dashboard HTTP server for the dcr-mcp-agent.
 *
 * Provides a web UI to manage agents (each with its own DCR client identity)
 * and run MCP tool calls against any registered agent.
 *
 * Routes:
 *   GET  /                  → dashboard HTML
 *   GET  /api/tools         → discover MCP tools (tools/list, static fallback)
 *   POST /api/agents/new    → register a new agent (full DCR flow → fresh client_id)
 *   GET  /api/agents        → list all agent records
 *   POST /api/runs          → start a run { agentId, toolName, args }
 *   GET  /api/runs          → list all run records
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

export type AgentStatus = "registering" | "ready" | "failed";
export type RunStatus   = "running"     | "succeeded" | "failed";

export interface AgentRecord {
  id: string;
  /** Human-readable name shown in the UI. */
  name: string;
  status: AgentStatus;
  /** OAuth client_id issued by the AS after DCR (set once ready). */
  clientId?: string;
  createdAt: string;
  /** Path to the per-agent credentials cache file. */
  credentialsPath: string;
  error?: string;
}

export interface RunRecord {
  id: string;
  agentId: string;
  agentName: string;
  toolName: string;
  args: Record<string, unknown>;
  status: RunStatus;
  startedAt: string;
  stoppedAt?: string;
  result?: unknown;
  error?: string;
}

// ── In-memory stores ─────────────────────────────────────────────────────────

const agents: AgentRecord[] = [];
const runs: RunRecord[] = [];
let agentCounter = 0;
let runCounter   = 0;

function newAgentId(): string { return `agent-${String(++agentCounter).padStart(4, "0")}`; }
function newRunId():   string { return `run-${String(++runCounter).padStart(4, "0")}`; }

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
      ".css":  "text/css",
      ".js":   "application/javascript",
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
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
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
    const metadata   = await discoverMetadata(baseConfig);
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

// ── Agent management ─────────────────────────────────────────────────────────

/**
 * Register a brand-new DCR client and create an agent record.
 * The registration runs asynchronously; the caller gets an immediate response
 * with status "registering", then the record updates to "ready" or "failed".
 */
async function createAgent(name: string): Promise<AgentRecord> {
  const id = newAgentId();
  const credentialsPath = `.dcr-credentials-${id}.json`;

  const record: AgentRecord = {
    id,
    name: name || id,
    status: "registering",
    createdAt: new Date().toISOString(),
    credentialsPath,
  };
  agents.unshift(record); // newest first

  // Run DCR asynchronously so the HTTP response returns immediately.
  (async () => {
    logger.info("Dashboard: starting DCR for new agent", { id, name: record.name });
    try {
      const metadata = await discoverMetadata(baseConfig);
      // Always perform a fresh registration — ignore any cached file for this path.
      const creds = await registerClient(
        metadata.registrationEndpoint,
        metadata.tokenEndpoint,
        { ...baseConfig, clientCredentialsPath: credentialsPath },
      );
      await saveCredentials(credentialsPath, creds);

      record.status   = "ready";
      record.clientId = creds.clientId;
      logger.info("Dashboard: agent registered successfully", {
        id,
        clientId: creds.clientId,
      });
    } catch (err) {
      record.status = "failed";
      record.error  = (err as Error).message ?? String(err);
      logger.error("Dashboard: agent DCR failed", { id, error: record.error });
    }
  })();

  return record;
}

// ── Run management ────────────────────────────────────────────────────────────

async function startRun(
  agentId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<RunRecord> {
  const agentRecord = agents.find((a) => a.id === agentId);
  if (!agentRecord) throw new Error(`Agent ${agentId} not found`);
  if (agentRecord.status !== "ready") {
    throw new Error(`Agent ${agentId} is not ready (status: ${agentRecord.status})`);
  }

  const record: RunRecord = {
    id: newRunId(),
    agentId,
    agentName: agentRecord.name,
    toolName,
    args,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  runs.unshift(record);

  (async () => {
    logger.info("Dashboard: starting run", {
      id: record.id,
      agentId,
      toolName,
      args,
    });
    try {
      // Give this agent its own credentials path so it uses its DCR identity.
      const config = {
        ...baseConfig,
        mcpToolName: toolName,
        mcpToolArgs: args,
        clientCredentialsPath: agentRecord.credentialsPath,
      };
      const agent  = new Agent(config);
      const result = await agent.runTask();

      record.status = result.isError ? "failed" : "succeeded";
      record.result = result.result;
      if (result.isError) {
        record.error =
          typeof result.result === "string"
            ? result.result
            : JSON.stringify(result.result);
      }
    } catch (err) {
      record.status = "failed";
      record.error  = (err as Error).message ?? String(err);
    } finally {
      record.stoppedAt = new Date().toISOString();
      logger.info("Dashboard: run completed", {
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
  const url    = req.url   ?? "/";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // ── GET / → dashboard HTML
  if (method === "GET" && (url === "/" || url === "/index.html")) {
    serveStatic(res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }

  // ── GET /api/tools
  if (method === "GET" && url === "/api/tools") {
    const tools = await discoverMcpTools();
    jsonResponse(res, 200, { tools });
    return;
  }

  // ── POST /api/agents/new → register a new agent (DCR)
  if (method === "POST" && url === "/api/agents/new") {
    let name = "";
    try {
      const raw = await readBody(req);
      if (raw.trim()) {
        const body = JSON.parse(raw) as { name?: string };
        name = body.name?.trim() ?? "";
      }
    } catch { /* ignore parse errors — name is optional */ }

    const record = await createAgent(name);
    jsonResponse(res, 202, record);
    return;
  }

  // ── GET /api/agents → list agents
  if (method === "GET" && url === "/api/agents") {
    jsonResponse(res, 200, { agents });
    return;
  }

  // ── POST /api/runs → start a run for an agent
  if (method === "POST" && url === "/api/runs") {
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch {
      jsonResponse(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const { agentId, toolName, args } = body as {
      agentId?: string;
      toolName?: string;
      args?: Record<string, unknown>;
    };

    if (!agentId || typeof agentId !== "string") {
      jsonResponse(res, 400, { error: "agentId (string) is required" });
      return;
    }
    if (!toolName || typeof toolName !== "string") {
      jsonResponse(res, 400, { error: "toolName (string) is required" });
      return;
    }

    try {
      const record = await startRun(
        agentId,
        toolName,
        args && typeof args === "object" ? args : {},
      );
      jsonResponse(res, 202, record);
    } catch (err) {
      jsonResponse(res, 400, { error: (err as Error).message });
    }
    return;
  }

  // ── GET /api/runs → list runs
  if (method === "GET" && url === "/api/runs") {
    jsonResponse(res, 200, { runs });
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
