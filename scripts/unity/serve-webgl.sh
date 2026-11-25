#!/usr/bin/env bash
# Static-serve a WebGL build on VPN/wg0:<port> (or HB_WEBGL_BIND / 127.0.0.1) with a reload poller.
# If Builds/WebGL is missing, still binds the port and serves a "Build in progress" placeholder.
# Survives atomic WebGL.next → WebGL swaps (re-resolves dir per request). Never defaults to 0.0.0.0.
# Usage: serve-webgl.sh [port] [Builds/WebGL dir]
set -euo pipefail

PORT="${1:-${UNITY_WEBGL_PORT:-8410}}"
if [[ -n "${2:-}" ]]; then
  DIR="$2"
elif [[ -d "${PWD}/Builds/WebGL" ]]; then
  DIR="${PWD}/Builds/WebGL"
elif [[ -n "${UNITY_PROJECT:-}" && -d "${UNITY_PROJECT}/Builds/WebGL" ]]; then
  DIR="${UNITY_PROJECT}/Builds/WebGL"
elif [[ -f "${PWD}/ProjectSettings/ProjectVersion.txt" ]]; then
  DIR="${PWD}/Builds/WebGL"
elif [[ -n "${UNITY_PROJECT:-}" ]]; then
  DIR="${UNITY_PROJECT}/Builds/WebGL"
else
  DIR="${HOME}/MCP_WORKSPACES/unity-sample/Builds/WebGL"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_JS="${SCRIPT_DIR}/serve-webgl.mjs"
BIND_JS="${SCRIPT_DIR}/webgl-bind.mjs"

mkdir -p "$DIR"
[[ -f "$SERVER_JS" ]] || { echo "error: missing $SERVER_JS" >&2; exit 1; }
[[ -f "$BIND_JS" ]] || { echo "error: missing $BIND_JS" >&2; exit 1; }

# Resolve bind host once for the banner (serve-webgl.mjs resolves again at listen).
BIND="$(node -e "import('${BIND_JS}').then(m=>process.stdout.write(m.resolveWebglBind()))")"

export UNITY_WEBGL_PORT="$PORT"
export UNITY_WEBGL_DIR="$DIR"
if [[ -f "$DIR/index.html" ]]; then
  echo "Serving WebGL on ${BIND}:${PORT} → ${DIR}"
else
  echo "Build in progress — placeholder on ${BIND}:${PORT} (run Build WebGL)"
fi
echo "Phone URL: http://${BIND}:${PORT}/"
exec node "$SERVER_JS"
