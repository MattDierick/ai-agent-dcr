#!/usr/bin/env bash
#
# Manual MCP Streamable HTTP test against a FastMCP server.
#
# Key facts about the MCP Streamable HTTP transport (what fixes your issue):
#   1. initialize is a POST (not GET). GET /mcp is only for opening an SSE stream.
#   2. The server returns an "Mcp-Session-Id" response header on initialize.
#      You MUST echo it back on every subsequent request.
#   3. After initialize you must send the "notifications/initialized" notification.
#   4. Accept header must include BOTH application/json and text/event-stream.
#
# Usage:
#   ./mcp-curl-test.sh
#
set -euo pipefail

URL="https://10.1.10.8/mcp"
TOKEN=""   # <-- put your real Bearer token here, or leave empty if auth is off

# Build auth header only if a token is provided.
AUTH_ARGS=()
if [[ -n "$TOKEN" ]]; then
  AUTH_ARGS=(--header "authorization: Bearer ${TOKEN}")
fi

# -k because you are hitting an IP over HTTPS (self-signed cert).
COMMON=(
  -k
  --silent --show-error
  --header "content-type: application/json"
  --header "accept: application/json, text/event-stream"
  "${AUTH_ARGS[@]}"
)

echo "==> Step 1: initialize (POST) and capture the Mcp-Session-Id header"
# -D - dumps response headers to stdout so we can grep the session id.
INIT_RESPONSE=$(curl "${COMMON[@]}" -D - --request POST --url "$URL" --data '{
  "jsonrpc": "2.0",
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": { "name": "test", "version": "1.0.0" }
  },
  "id": 1
}')

echo "$INIT_RESPONSE"
echo

# Extract the session id from the response headers (case-insensitive).
SESSION_ID=$(printf '%s\n' "$INIT_RESPONSE" \
  | grep -i '^mcp-session-id:' \
  | sed -E 's/^[Mm]cp-[Ss]ession-[Ii]d:[[:space:]]*//' \
  | tr -d '\r')

if [[ -z "$SESSION_ID" ]]; then
  echo "ERROR: No Mcp-Session-Id returned. Check auth/token and that the server is stateful." >&2
  exit 1
fi
echo "==> Got session id: $SESSION_ID"
echo

echo "==> Step 1b: send notifications/initialized (required before tool calls)"
curl "${COMMON[@]}" \
  --header "mcp-session-id: ${SESSION_ID}" \
  --request POST --url "$URL" --data '{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}'
echo
echo

echo "==> Step 2: tools/call (POST) WITH the session id header"
curl "${COMMON[@]}" \
  --header "mcp-session-id: ${SESSION_ID}" \
  --request POST --url "$URL" --data '{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "add",
    "arguments": { "a": 9, "b": 7 }
  },
  "id": 2
}'
echo
