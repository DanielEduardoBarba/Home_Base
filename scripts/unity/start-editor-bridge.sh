#!/usr/bin/env bash
# Start Unity Editor headless with Coplay MCP stdio bridge (default :6400).
# No Hub GUI, no license activate/return/sign-in.
set -euo pipefail

# Resolve seat home even when systemd/service HOME=/root (HB-U-03).
if [[ -z "${HOME:-}" || "$HOME" == "/root" ]]; then
  if [[ -d /home/daniel ]]; then HOME=/home/daniel; fi
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UNITY_DEFAULT="${HOME}/Unity/Hub/Editor/6000.6.4f1/Editor/Unity"
UNITY="${UNITY_EDITOR:-${UNITY:-$UNITY_DEFAULT}}"
if [[ -n "${1:-}" ]]; then
  PROJECT="$1"
elif [[ -n "${UNITY_PROJECT:-}" ]]; then
  PROJECT="$UNITY_PROJECT"
elif [[ -f "${PWD}/ProjectSettings/ProjectVersion.txt" ]]; then
  PROJECT="$PWD"
else
  PROJECT="${HOME}/MCP_WORKSPACES/unity-sample"
fi
BRIDGE_PORT="${UNITY_MCP_PORT:-6400}"
LOG="${UNITY_BRIDGE_LOG:-${HOME}/.cache/homebase-unity/bridge.log}"
PIDFILE="${UNITY_BRIDGE_PIDFILE:-${HOME}/.cache/homebase-unity/bridge.pid}"
STATUS_DIR="${UNITY_MCP_STATUS_DIR:-${HOME}/.unity-mcp}"
BOOT_METHOD="${UNITY_MCP_BOOT_METHOD:-MCPForUnity.Editor.McpCiBoot.StartStdioForCi}"
WAIT_SECS="${UNITY_BRIDGE_WAIT_SECS:-180}"
MCP_PKG_URL="${UNITY_MCP_PACKAGE_URL:-https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main}"

mkdir -p "$(dirname "$LOG")" "$STATUS_DIR"

# Persist Coplay PortManager config so the Editor listens on UNITY_MCP_PORT
# (hashed + legacy files under ~/.unity-mcp; project_path = <project>/Assets).
write_bridge_port_config() {
  local port="$1"
  local assets="${PROJECT}/Assets"
  python3 - "$STATUS_DIR" "$assets" "$port" <<'PY' || true
import hashlib, json, pathlib, sys
from datetime import datetime, timezone
status_dir, assets, port = pathlib.Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
status_dir.mkdir(parents=True, exist_ok=True)
h = hashlib.sha1(assets.encode()).hexdigest()[:8]
body = {
    "unity_port": port,
    "created_date": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "project_path": assets,
}
text = json.dumps(body, indent=2) + "\n"
(status_dir / f"unity-mcp-port-{h}.json").write_text(text)
(status_dir / "unity-mcp-port.json").write_text(text)
print(f"Wrote MCP bridge port {port} for {assets}")
PY
}
write_bridge_port_config "$BRIDGE_PORT"

die() { echo "error: $*" >&2; exit 1; }

[[ -x "$UNITY" ]] || die "Unity Editor not found at $UNITY (set UNITY_EDITOR)"
command -v python3 >/dev/null || die "python3 required"

ensure_project() {
  if [[ -f "$PROJECT/ProjectSettings/ProjectVersion.txt" ]]; then
    return 0
  fi
  echo "Creating Unity project at $PROJECT …"
  mkdir -p "$(dirname "$PROJECT")"
  local create_log
  create_log="$(dirname "$LOG")/create-$(basename "$PROJECT").log"
  "$UNITY" -batchmode -nographics -quit \
    -createProject "$PROJECT" \
    -logFile "$create_log" || die "createProject failed — see $create_log"
}

ensure_mcp_package() {
  local manifest="$PROJECT/Packages/manifest.json"
  mkdir -p "$PROJECT/Packages"
  if [[ ! -f "$manifest" ]]; then
    printf '%s\n' '{' '  "dependencies": {}' '}' >"$manifest"
  fi
  python3 - "$manifest" "$MCP_PKG_URL" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
url = sys.argv[2]
data = json.loads(path.read_text() or '{"dependencies":{}}')
deps = data.setdefault("dependencies", {})
key = "com.coplaydev.unity-mcp"
if deps.get(key) != url:
    deps[key] = url
    path.write_text(json.dumps(data, indent=2) + "\n")
    print(f"Added {key}")
else:
    print(f"{key} already present")
PY
}

port_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE ":${port}[[:space:]]"
    return $?
  fi
  python3 - "$port" <<'PY'
import socket, sys
s = socket.socket()
s.settimeout(0.4)
try:
    s.connect(("127.0.0.1", int(sys.argv[1])))
    raise SystemExit(0)
except OSError:
    raise SystemExit(1)
finally:
    s.close()
PY
}

already_running_for_project() {
  if [[ -f "$PIDFILE" ]]; then
    local old
    old="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [[ -n "${old}" ]] && kill -0 "$old" 2>/dev/null; then
      if tr '\0' ' ' <"/proc/$old/cmdline" 2>/dev/null | grep -q -- "-projectPath ${PROJECT}"; then
        return 0
      fi
    fi
  fi
  pgrep -af "Unity.*-projectPath ${PROJECT}" >/dev/null 2>&1
}

ensure_project
ensure_mcp_package

if already_running_for_project; then
  echo "Editor already running for $PROJECT"
else
  # Warm import once (quit) so package compile finishes before resident boot.
  local_warm="$(dirname "$LOG")/warmup-$(basename "$PROJECT").log"
  echo "Warming project import…"
  "$UNITY" -batchmode -nographics -quit \
    -projectPath "$PROJECT" \
    -logFile "$local_warm" || true

  : >"$LOG"
  echo "Starting bridge Editor (batchmode + ${BOOT_METHOD})…"
  env UNITY_MCP_ALLOW_BATCH=1 \
    UNITY_MCP_STATUS_DIR="$STATUS_DIR" \
    nohup "$UNITY" -batchmode -nographics \
      -projectPath "$PROJECT" \
      -logFile "$LOG" \
      -executeMethod "$BOOT_METHOD" \
      >/dev/null 2>&1 &
  echo $! >"$PIDFILE"
  echo "Started Unity PID $(cat "$PIDFILE") (log $LOG)"
fi

echo "Waiting up to ${WAIT_SECS}s for MCP bridge on 127.0.0.1:${BRIDGE_PORT}…"
deadline=$((SECONDS + WAIT_SECS))
while (( SECONDS < deadline )); do
  if port_listening "$BRIDGE_PORT"; then
    echo "MCP bridge listening on 127.0.0.1:${BRIDGE_PORT}"
    # Prefer status file when present
    if ls "$STATUS_DIR"/unity-mcp-status-*.json >/dev/null 2>&1; then
      python3 - "$STATUS_DIR" <<'PY' 2>/dev/null || true
import json, pathlib, sys
d = pathlib.Path(sys.argv[1])
files = sorted(d.glob("unity-mcp-status-*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
for f in files[:3]:
    try:
        data = json.loads(f.read_text())
        port = data.get("unity_port") or data.get("port")
        print(f"status {f.name}: port={port} id={data.get('instance_id') or data.get('id') or '?'}")
    except Exception:
        pass
PY
    fi
    exit 0
  fi
  sleep 2
done

echo "Timed out waiting for :${BRIDGE_PORT}. Tail of log:" >&2
tail -n 40 "$LOG" >&2 || true
exit 1
