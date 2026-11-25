#!/usr/bin/env bash
# Static-serve a WebGL build on 0.0.0.0:<port> with a tiny reload poller.
# Usage: serve-webgl.sh [port] [Builds/WebGL dir]
set -euo pipefail

PORT="${1:-${UNITY_WEBGL_PORT:-8410}}"
if [[ -n "${2:-}" ]]; then
  DIR="$2"
elif [[ -d "${PWD}/Builds/WebGL" ]]; then
  DIR="${PWD}/Builds/WebGL"
elif [[ -n "${UNITY_PROJECT:-}" && -d "${UNITY_PROJECT}/Builds/WebGL" ]]; then
  DIR="${UNITY_PROJECT}/Builds/WebGL"
else
  DIR="${HOME}/MCP_WORKSPACES/unity-sample/Builds/WebGL"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_JS="${SCRIPT_DIR}/serve-webgl.mjs"

[[ -d "$DIR" ]] || { echo "error: WebGL build dir missing: $DIR" >&2; exit 1; }
[[ -f "$SERVER_JS" ]] || { echo "error: missing $SERVER_JS" >&2; exit 1; }

export UNITY_WEBGL_PORT="$PORT"
export UNITY_WEBGL_DIR="$DIR"
echo "Serving WebGL on 0.0.0.0:${PORT} → ${DIR}"
echo "Phone URL: http://10.6.0.1:${PORT}/"
exec node "$SERVER_JS"
