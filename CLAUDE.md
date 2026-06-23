# CLAUDE.md

This file provides guidance to Claude Code (or any AI coding assistant) when working on this project.

## Project Overview

This project builds an **AI agent** that authenticates against an OAuth 2.0 Authorization Server (AS) using **Dynamic Client Registration (DCR)**, obtains an access token (JWT), and then uses that token to run tasks against a **Model Context Protocol (MCP) server**.

The full flow is:

1. **Dynamic Client Registration (DCR)** — The agent registers itself with the OAuth AS at runtime via the RFC 7591 registration endpoint and receives a `client_id` and `client_secret`.
2. **Token Acquisition** — The agent uses the registered credentials to request a JWT access token from the OAuth AS token endpoint (RFC 6749 / RFC 8693).
3. **MCP Task Execution** — The agent connects to an MCP server, presents the bearer token, discovers available tools, and invokes one (or more) tools to complete a task.

```
┌──────────┐  1. POST /register (DCR)     ┌──────────────────┐
│          │ ───────────────────────────► │                  │
│          │ ◄─────────────────────────── │   OAuth 2.0 AS   │
│          │   client_id + client_secret  │  (DCR-enabled)   │
│ AI Agent │                              │                  │
│          │  2. POST /token              │                  │
│          │ ───────────────────────────► │                  │
│          │ ◄─────────────────────────── │                  │
│          │   JWT access_token           └──────────────────┘
│          │
│          │  3. tools/call (Bearer JWT)  ┌──────────────────┐
│          │ ───────────────────────────► │                  │
│          │ ◄─────────────────────────── │   MCP Server     │
└──────────┘   task result                └──────────────────┘
```

## Standards & References

The implementation MUST follow these specifications:

- **OAuth 2.0** — RFC 6749 (Authorization Framework)
- **Dynamic Client Registration** — RFC 7591 (OAuth 2.0 Dynamic Client Registration Protocol)
- **DCR Management** — RFC 7592 (optional, for updating/deleting registrations)
- **Authorization Server Metadata** — RFC 8414 (discover endpoints from `/.well-known/oauth-authorization-server`)
- **JWT** — RFC 7519 (token format and claims validation)
- **OAuth for MCP** — MCP Authorization spec (MCP servers act as OAuth-protected resources; honor the `WWW-Authenticate` header and resource metadata per RFC 9728 Protected Resource Metadata)
- **Model Context Protocol (MCP)** — https://modelcontextprotocol.io/ (JSON-RPC 2.0 over stdio or Streamable HTTP/SSE)

## Architecture / Module Layout

Keep concerns separated into clear modules:

```
src/
  config/        # Configuration loading & validation (env vars, defaults)
  oauth/
    discovery.ts # AS metadata discovery (RFC 8414 / RFC 9728)
    dcr.ts       # Dynamic Client Registration (RFC 7591)
    token.ts     # Token request, caching, and refresh
  mcp/
    client.ts    # MCP client connection (HTTP/SSE or stdio)
    tasks.ts     # Task orchestration: list tools, call tools
  agent/
    agent.ts     # High-level agent that wires oauth + mcp together
  index.ts       # Entry point / CLI
tests/           # Unit + integration tests
```

## Detailed Flow Requirements

### Step 1 — Authorization Server Discovery (recommended)
- Fetch AS metadata from `<AS_ISSUER>/.well-known/openid-configuration` (RFC 8414).
- Extract `registration_endpoint`, `token_endpoint`, `jwks_uri`, `issuer`, and supported `grant_types`/`token_endpoint_auth_methods`.
- Fall back to explicitly configured endpoints if metadata is unavailable.

### Step 2 — Dynamic Client Registration (RFC 7591)
- `POST` to the `registration_endpoint` with a client metadata JSON body, e.g.:
  ```json
  {
    "client_name": "dcr-mcp-agent",
    "grant_types": ["client_credentials"],
    "token_endpoint_auth_method": "client_secret_basic",
    "scope": "<requested scopes>"
  }
  ```
- If the AS requires an **initial access token**, send it as `Authorization: Bearer <initial_access_token>`.
- Parse the response to extract `client_id`, `client_secret`, `client_id_issued_at`, `client_secret_expires_at`, and (if present) `registration_access_token` + `registration_client_uri` (for RFC 7592 management).
- **Persist/cache** the credentials securely so the agent does not re-register on every run (only re-register if the secret is expired or missing).

### Step 3 — Token Request (RFC 6749 client_credentials)
- `POST` to `token_endpoint` with:
  ```
  grant_type=client_credentials
  scope=<scopes>
  ```
- Authenticate using `client_secret_basic` (HTTP Basic) by default, or `client_secret_post` if the AS requires it.
- Expect a JWT `access_token`. Optionally validate it locally:
  - Verify signature against `jwks_uri`.
  - Validate `iss`, `aud`, `exp`, and required scopes.
- **Cache** the token and proactively refresh it before `exp` (subtract a safety skew, e.g. 30–60s).

### Step 4 — MCP Task Execution
- Initialize the MCP session (JSON-RPC `initialize` handshake).
- Pass the JWT as `Authorization: Bearer <access_token>` on the HTTP transport (or per MCP auth requirements).
- Handle the MCP OAuth challenge: if the server returns `401` with `WWW-Authenticate`, parse the resource metadata and (re)acquire a token scoped to that resource.
- `tools/list` to discover available tools; `tools/call` to run the requested task.
- Return/print the structured tool result.

## Configuration

All configuration via environment variables (with a `.env` file for local dev, **never committed**):

| Variable | Description | Required |
|----------|-------------|----------|
| `OAUTH_AS_ISSUER` | Base issuer URL of the OAuth AS | Yes |
| `OAUTH_REGISTRATION_ENDPOINT` | Override DCR endpoint (else discovered) | No |
| `OAUTH_TOKEN_ENDPOINT` | Override token endpoint (else discovered) | No |
| `OAUTH_INITIAL_ACCESS_TOKEN` | Initial access token for DCR, if required | No |
| `OAUTH_SCOPE` | Scopes to request | No |
| `MCP_SERVER_URL` | URL of the MCP server | Yes |
| `MCP_TOOL_NAME` | Tool to invoke | Depends on task |
| `MCP_TOOL_ARGS` | JSON arguments for the tool | Depends on task |
| `CLIENT_CREDENTIALS_PATH` | File path to cache DCR credentials | No |

## Security Requirements

- **NEVER** hardcode `client_secret`, tokens, or initial access tokens in source code.
- **NEVER** commit `.env`, credential cache files, or tokens. Ensure they are in `.gitignore`.
- Store cached credentials with restrictive file permissions (`0600`).
- Always use **HTTPS/TLS** for AS and MCP endpoints; reject plaintext HTTP except for `localhost` during development.
- Redact secrets and tokens in all logs (log only token prefixes/lengths, never full values).
- Validate JWT `exp`/`aud`/`iss` before use; do not trust unvalidated tokens.
- Use minimal scopes (principle of least privilege).
- Handle and retry on `invalid_client` / `invalid_token` by re-registering or re-fetching a token, with backoff.

## Coding Conventions

- Prefer **TypeScript/Node.js** unless the user specifies otherwise (the official MCP SDK is `@modelcontextprotocol/sdk`).
- Use `async/await`; no unhandled promise rejections.
- Strong typing for all OAuth and MCP request/response shapes.
- Small, single-responsibility functions; pure logic separated from I/O where practical.
- Meaningful error messages that distinguish DCR errors, token errors, and MCP errors.
- Add structured logging with levels (`debug`, `info`, `warn`, `error`).

## Error Handling Expectations

| Failure | Expected behavior |
|---------|-------------------|
| Discovery fails | Fall back to configured endpoints; error if none |
| DCR returns 4xx | Surface the OAuth `error`/`error_description`; do not retry blindly |
| `client_secret_expires_at` passed | Re-register automatically |
| Token request `invalid_client` | Re-register once, then fail |
| Token expired mid-task | Refresh token transparently and retry the MCP call once |
| MCP `401` w/ `WWW-Authenticate` | Re-acquire token for the indicated resource, retry once |
| MCP tool error | Return the tool's structured error to the caller |

## Testing

- **Unit tests** for: discovery parsing, DCR request building/response parsing, token request/auth method selection, JWT validation, token cache expiry logic.
- **Integration tests** with a mock OAuth AS and a mock MCP server (or local containers).
- Mock all network calls in unit tests; never hit real endpoints in CI.
- Run tests with: `npm test` (configure accordingly).

## Suggested Commands

```bash
# Install dependencies
npm install

# Run the agent end-to-end (uses .env)
npm start

# Type-check
npm run typecheck

# Lint
npm run lint

# Run tests
npm test
```

## Definition of Done

A change is complete when:
- [ ] The agent can register via DCR and obtain `client_id`/`client_secret`.
- [ ] The agent can exchange credentials for a valid JWT access token.
- [ ] The agent can connect to the MCP server with the bearer token and run a task.
- [ ] Credentials/tokens are cached, refreshed, and never leaked in logs or git.
- [ ] Errors at each stage are handled per the table above.
- [ ] Tests pass and lint/typecheck are clean.
