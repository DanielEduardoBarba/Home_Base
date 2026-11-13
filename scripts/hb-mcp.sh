#!/bin/bash
# Home Base MCP client helper. Tokens come from the environment, never this file.
# Usage:
#   HOMEBASE_MCP_URL=http://<vpn-ip>:8080/mcp
#   HOMEBASE_MCP_TOKEN=<access>
#   HOMEBASE_MCP_REFRESH_TOKEN=<refresh>   # optional, used once on mcp_token_expired
#   scripts/hb-mcp.sh <tool> '<json args>'
#
# On HTTP 401: print the server JSON and exit 1. Do not loop. If the code is
# mcp_token_expired and a refresh token is set, refresh once, then retry once.
set -euo pipefail

URL="${HOMEBASE_MCP_URL:?set HOMEBASE_MCP_URL}"
TOKEN="${HOMEBASE_MCP_TOKEN:?set HOMEBASE_MCP_TOKEN}"
TOOL="${1:?tool name}"
ARGS="${2:-{}}"

rpc() {
  local tok="$1"
  curl -sS -m 30 -D - \
    -H "Authorization: Bearer ${tok}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"${TOOL}\",\"arguments\":${ARGS}}}" \
    "$URL"
}

extract_status() { awk 'BEGIN{s=0} NR==1||($0 ~ /^HTTP\//){s=$2} END{print s}' ; }

RESP="$(rpc "$TOKEN")"
STATUS="$(printf '%s\n' "$RESP" | extract_status)"
BODY="$(printf '%s\n' "$RESP" | awk 'BEGIN{p=0} p{print} /^\r?$/{p=1}')"

if [ "$STATUS" = "401" ]; then
  CODE="$(printf '%s' "$BODY" | python3 -c 'import json,sys
t=sys.stdin.read()
try:
  d=json.loads(t)
  det=d.get("detail",d)
  print(det.get("code","") if isinstance(det,dict) else "")
except Exception:
  print("")
' 2>/dev/null || true)"
  if [ "$CODE" = "mcp_token_expired" ] && [ -n "${HOMEBASE_MCP_REFRESH_TOKEN:-}" ]; then
    BASE="${URL%/mcp}"
    NEW="$(curl -sS -m 30 -H "Authorization: Bearer ${HOMEBASE_MCP_REFRESH_TOKEN}" -H "Content-Type: application/json" -d '{}' "${BASE}/mcp/token")"
    TOKEN="$(printf '%s' "$NEW" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d.get("accessToken") or d.get("token") or "")')"
    REFRESH="$(printf '%s' "$NEW" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d.get("refreshToken") or "")')"
    if [ -z "$TOKEN" ]; then
      echo "Refresh failed: $NEW" >&2
      exit 1
    fi
    if [ -n "$REFRESH" ]; then
      echo "Refreshed access token. Store the new refresh token; the previous one is no longer valid." >&2
    fi
    RESP="$(rpc "$TOKEN")"
    STATUS="$(printf '%s\n' "$RESP" | extract_status)"
    BODY="$(printf '%s\n' "$RESP" | awk 'BEGIN{p=0} p{print} /^\r?$/{p=1}')"
  fi
  if [ "$STATUS" = "401" ]; then
    echo "HTTP 401 — stopping. Do not retry this request." >&2
    printf '%s\n' "$BODY"
    exit 1
  fi
fi

printf '%s\n' "$BODY" | python3 -c '
import json,sys
raw=sys.stdin.read()
try:
  r=json.loads(raw)
  if r.get("result") and r["result"].get("content"):
    print("\n".join(c.get("text","") for c in r["result"]["content"]))
  else:
    print(json.dumps(r.get("error") or r))
except Exception:
  print(raw)
'
