#!/usr/bin/env bash
# WebGL live view: serve immediately ("Build in progress" placeholder if needed) + watch
# Assets/Packages/ProjectSettings → debounced batchmode rebuild (atomic WebGL.next swap) →
# auto-reload via serve-webgl.mjs poller. Preview stays up across rebuilds.
#
# Coplay bridge coordination (one Editor per project lock):
#   STOP this project's bridge before each batchmode WebGL build, then RESTART it
#   after the build finishes (success or fail). Authoring via bridge and WebGL
#   batchmode cannot share one project lock during the build itself.
set -euo pipefail

# Resolve seat home even when systemd/service HOME=/root (HB-U-03).
if [[ -z "${HOME:-}" || "$HOME" == "/root" ]]; then
  if [[ -d /home/daniel ]]; then HOME=/home/daniel; fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${UNITY_WEBGL_PORT:-}"
if [[ -z "$PORT" ]]; then
  for a in "$@"; do
    if [[ "$a" =~ ^[0-9]+$ ]]; then PORT="$a"; break; fi
  done
fi
PORT="${PORT:-8410}"

if [[ -f "${PWD}/ProjectSettings/ProjectVersion.txt" ]]; then
  PROJECT="$PWD"
elif [[ -n "${UNITY_PROJECT:-}" ]]; then
  PROJECT="$UNITY_PROJECT"
else
  PROJECT="${HOME}/MCP_WORKSPACES/unity-sample"
fi
OUT="${PROJECT}/Builds/WebGL"
DEBOUNCE_SEC="${UNITY_WEBGL_DEBOUNCE:-8}"
STATE_DIR="${HOME}/.cache/homebase-unity"
mkdir -p "$STATE_DIR" "$OUT"
WATCH_PIDFILE="${STATE_DIR}/live-webgl-watch-$$.pid"
BUILD_LOCK="${STATE_DIR}/webgl-build.lock"
LAST_BUILD_ERR="${STATE_DIR}/webgl-build-last-error.txt"

# Resolve port from Home Base action args / env
export UNITY_WEBGL_PORT="$PORT"
export UNITY_PROJECT="$PROJECT"

stop_bridge_if_ours() {
  if [[ -x "${SCRIPT_DIR}/stop-editor-bridge.sh" ]]; then
    echo "[live-webgl] stopping Coplay bridge for this project (project lock)…"
    UNITY_PROJECT="$PROJECT" bash "${SCRIPT_DIR}/stop-editor-bridge.sh" "$PROJECT" || true
  fi
}

restart_bridge() {
  if [[ "${UNITY_WEBGL_RESTART_BRIDGE:-1}" != "1" ]]; then
    return 0
  fi
  if [[ -x "${SCRIPT_DIR}/start-editor-bridge.sh" ]]; then
    echo "[live-webgl] restarting Coplay bridge after build…"
    UNITY_PROJECT="$PROJECT" bash "${SCRIPT_DIR}/start-editor-bridge.sh" "$PROJECT" \
      || echo "[live-webgl] bridge restart failed (preview still serving)" >&2
  fi
}

build_once() {
  # flock so watch bursts don't overlap builds
  (
    flock -n 9 || { echo "[live-webgl] build already running — skip"; exit 0; }
    stop_bridge_if_ours
    set +e
    bash "${SCRIPT_DIR}/build-webgl.sh" "$PROJECT" "$OUT"
    local code=$?
    set -e
    if [[ $code -ne 0 ]]; then
      local msg="WebGL build failed (exit $code) — see ~/.cache/homebase-unity/webgl-build.log"
      echo "[live-webgl] $msg" >&2
      echo "$msg" >"$LAST_BUILD_ERR"
      restart_bridge
      exit "$code"
    fi
    rm -f "$LAST_BUILD_ERR"
    echo "[live-webgl] build ok → $OUT"
    restart_bridge
  ) 9>"$BUILD_LOCK"
}

# Bring the port up immediately (placeholder until index.html exists).
echo "[live-webgl] starting preview on :$PORT → $OUT"
bash "${SCRIPT_DIR}/serve-webgl.sh" "$PORT" "$OUT" &
SERVE_PID=$!

cleanup() {
  kill "$SERVE_PID" 2>/dev/null || true
  if [[ -f "$WATCH_PIDFILE" ]]; then
    kill "$(cat "$WATCH_PIDFILE" 2>/dev/null || true)" 2>/dev/null || true
    rm -f "$WATCH_PIDFILE"
  fi
}
trap cleanup EXIT

# Initial build if missing (port already serving placeholder).
if [[ ! -f "$OUT/index.html" ]]; then
  echo "[live-webgl] no build yet — building once…"
  build_once || echo "[live-webgl] initial build failed — placeholder stays up (see $LAST_BUILD_ERR)"
fi

# Debounced watcher
watch_loop_v2() {
  echo "[live-webgl] watching Assets Packages ProjectSettings (debounce ${DEBOUNCE_SEC}s)"
  local stamp="${STATE_DIR}/live-webgl-pending-$$"
  rm -f "$stamp"
  (
    if command -v inotifywait >/dev/null 2>&1; then
      inotifywait -m -r -e modify,create,delete,move \
        --exclude '(/Library/|/Temp/|/Logs/|/Builds/|\.git/)' \
        "$PROJECT/Assets" "$PROJECT/Packages" "$PROJECT/ProjectSettings" 2>/dev/null |
      while read -r _; do
        date +%s >"$stamp"
      done
    else
      local prev=""
      while true; do
        local cur
        cur="$(find "$PROJECT/Assets" "$PROJECT/Packages" "$PROJECT/ProjectSettings" \
          -type f -printf '%T@ %p\n' 2>/dev/null | sort | md5sum | awk '{print $1}')"
        if [[ -n "$prev" && "$cur" != "$prev" ]]; then
          date +%s >"$stamp"
        fi
        prev="$cur"
        sleep 2
      done
    fi
  ) &
  local wpid=$!
  echo "$wpid" >"$WATCH_PIDFILE"

  local last_built=0
  while kill -0 "$wpid" 2>/dev/null && kill -0 "$SERVE_PID" 2>/dev/null; do
    if [[ -f "$stamp" ]]; then
      local t now
      t="$(cat "$stamp" 2>/dev/null || echo 0)"
      now="$(date +%s)"
      if (( now - t >= DEBOUNCE_SEC && t > last_built )); then
        last_built=$now
        rm -f "$stamp"
        echo "[live-webgl] debounced rebuild…"
        build_once || echo "[live-webgl] rebuild failed (see $LAST_BUILD_ERR)"
      fi
    fi
    sleep 1
  done
}

watch_loop_v2 &
WATCH_BG=$!
trap 'kill $WATCH_BG 2>/dev/null || true; cleanup' EXIT

wait "$SERVE_PID"
