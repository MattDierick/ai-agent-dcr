# dcr-mcp-agent

An AI agent that authenticates against an OAuth 2.0 Authorization Server using
**Dynamic Client Registration (DCR)**, obtains a JWT access token, and uses it
to run a task against a **Model Context Protocol (MCP)** server.

It implements the flow described in `CLAUDE.md`:

1. **Discovery** — AS metadata via `/.well-known/openid-configuration` (RFC 8414).
2. **DCR** — register the client at the registration endpoint (RFC 7591). The
   registration request is authenticated with **HTTP Basic auth** using an
   Initial Access Token (IAT) `client_id` / `client_secret` (`DCR_CLIENT_ID` /
   `DCR_CLIENT_SECRET`), and sends a form-encoded body with exactly two keys:
   `grant_type=client_credentials` and `scope=<DCR_SCOPE>` (default `scope-dcr`).
3. **Token** — `client_credentials` grant for a JWT (RFC 6749).

4. **MCP** — `initialize` → `tools/list` → `tools/call`, presenting `Authorization: Bearer <jwt>`.

By default the agent invokes the MCP **`add`** tool with `{ "a": 9, "b": 7 }`
(=> `16`), matching the demo `tools/call` payload:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": { "name": "add", "arguments": { "a": 9, "b": 7 } },
  "id": 2
}
```

## Configuration

All configuration is via environment variables — **nothing is hardcoded**.
See `.env.example`. The two required variables are:

| Variable | Description |
|----------|-------------|
| `OAUTH_AS_ISSUER` | Base issuer URL of the OAuth AS |
| `MCP_SERVER_URL`  | URL of the MCP server |
| `DCR_CLIENT_ID`   | IAT client ID for HTTP Basic auth on the DCR request |
| `DCR_CLIENT_SECRET` | IAT client secret for HTTP Basic auth on the DCR request |

Optional: `DCR_SCOPE` (default `scope-dcr`), `OAUTH_REGISTRATION_ENDPOINT`,
`OAUTH_TOKEN_ENDPOINT`, `OAUTH_INITIAL_ACCESS_TOKEN`, `OAUTH_SCOPE`,
`MCP_TOOL_NAME`, `MCP_TOOL_ARGS`, `CLIENT_CREDENTIALS_PATH`, `LOG_LEVEL`.


## Tool configuration

Override the default `add(9,7)` demo with `MCP_TOOL_NAME` and `MCP_TOOL_ARGS`.
`MCP_TOOL_ARGS` must be a **JSON object** (keys double-quoted, values unquoted for numbers):

```bash
# Inline for a single run (single-quote the JSON so the shell doesn't expand it)
MCP_TOOL_NAME=add MCP_TOOL_ARGS='{"a":9,"b":7}' npm start

# Or export for the whole session
export MCP_TOOL_NAME=add
export MCP_TOOL_ARGS='{"a":9,"b":7}'
npm start

# Or set in .env (no quotes needed)
# MCP_TOOL_NAME=add
# MCP_TOOL_ARGS={"a":9,"b":7}
```

### Passing tool and args directly on the `node --env-file` command

You can pass the tool name and its arguments as **positional CLI arguments** after
the script path — no `.env` changes needed. The `.env` file is still used for
secrets (`OAUTH_AS_ISSUER`, `MCP_SERVER_URL`, etc.), while the tool and its args
are supplied inline:

```bash
node --env-file=.env --import tsx src/index.ts add '{"a":7,"b":11}'
#                                                ^^^  ^^^^^^^^^^^^^
#                                         tool name   args JSON (single-quoted)
```

| Position | Example value | Effect |
|----------|---------------|--------|
| `argv[2]` | `add` | sets `MCP_TOOL_NAME=add` |
| `argv[3]` | `'{"a":7,"b":11}'` | sets `MCP_TOOL_ARGS={"a":7,"b":11}` |

CLI arguments take precedence over anything in `.env`. If omitted, the defaults
(`add` with `{"a":9,"b":7}`) still apply.

More examples:

```bash
# A tool with string + number args
MCP_TOOL_NAME=greet MCP_TOOL_ARGS='{"name":"Alice","times":3}' npm start

# A tool with no arguments
MCP_TOOL_NAME=ping MCP_TOOL_ARGS='{}' npm start
```

The exact JSON-RPC body for both the `initialize` handshake and the `tools/call`
request is printed in the logs (look for `MCP init: sending initialize request`
and `MCP request: sending tools/call`), so you can confirm exactly what was sent.

## Usage

```bash
npm install

# Provide the endpoints via the environment (never hardcoded)
export OAUTH_AS_ISSUER="https://your-as.example.com"
export MCP_SERVER_URL="https://your-mcp.example.com/mcp"

npm start
```

## Web Dashboard

The dashboard is a local web UI that lets you start agent runs, select an MCP
tool, enter arguments, and watch results update in real time — without touching
the CLI.

### 1 — Configure your environment

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

At minimum set:

```
OAUTH_AS_ISSUER=https://your-auth-server.example.com
MCP_SERVER_URL=https://your-mcp-server.example.com/mcp
DCR_CLIENT_ID=your-iat-client-id
DCR_CLIENT_SECRET=your-iat-client-secret
```

> Optional: set `DASHBOARD_PORT=8080` (default `3000`) to change the listening port.

### 2 — Start the dashboard

```bash
# Node 20+ built-in env-file loader (recommended)
node --env-file=.env --import tsx src/dashboard/server.ts

# Or: export the env manually, then use the npm script
export $(grep -v '^#' .env | xargs) && npm run dashboard
```

### 3 — Open the browser

```
http://localhost:3000
```

### What the dashboard provides

| Feature | Detail |
|---------|--------|
| **🤖 Agents panel** | Create agents with **＋ New Agent** — each gets its own DCR registration (`client_id`) from the AS |
| **Agent status** | 🟣 registering → 🟢 ready / 🔴 failed, with the issued `client_id` displayed |
| **🚀 Start Agent Run** | Pick an agent (from the ready list), a tool, arguments, then click **▶ Start** |
| **Tool dropdown** | Populated automatically via `tools/list` (static fallback: add/subtract/multiply/divide) |
| **Argument inputs** | Numeric `a` / `b` fields plus an optional raw-JSON extra-args field |
| **📋 Runs table** | Shows run ID, which agent executed it, tool, args, status badge (🟡 running → 🟢 succeeded / 🔴 failed), timestamps, and the MCP result |
| **Auto-refresh** | Agents and runs tables both poll every 2 seconds — no manual reload needed |

Each new agent performs a full two-step DCR (IAT → register) and caches its
credentials in `.dcr-credentials-<agentId>.json` (0600, already git-ignored).

### Dashboard API (for scripting)

```bash
# List available MCP tools
curl http://localhost:3000/api/tools

# Create a new agent (triggers DCR registration)
curl -X POST http://localhost:3000/api/agents/new \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent"}'

# List all agents
curl http://localhost:3000/api/agents

# Start a run for a specific agent
curl -X POST http://localhost:3000/api/runs \
  -H "Content-Type: application/json" \
  -d '{"agentId":"agent-0001","toolName":"add","args":{"a":9,"b":7}}'

# List all runs
curl http://localhost:3000/api/runs
```


## Development

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest (mocked network; no real endpoints)
```

## Security

- Secrets/URLs come only from the environment; `.env` and credential caches are git-ignored.
- DCR credentials are cached with `0600` permissions.
- Secrets and tokens are redacted in logs (prefix + length only).
- HTTPS is enforced for AS/MCP endpoints (plaintext HTTP allowed only for `localhost`).
