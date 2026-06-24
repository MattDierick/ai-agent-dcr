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
