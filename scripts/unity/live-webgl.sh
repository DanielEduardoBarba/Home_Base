#!/usr/bin/env bash
# WebGL live view: initial build (if needed) + watch Assets/Packages/ProjectSettings
# → debounced batchmode rebuild → static serve on 0.0.0.0:<port> with reload poller.
#
# Coplay bridge coordination (documented choice):
#   One Editor holds the project lock. If this project's bridge Editor is running,
#   we STOP it before each batchmode WebGL build, then leave it stopped while live
#   view is serving (authoring via bridge and WebGL batchmode cannot share one
#   project). We do NOT call Coplay manage_build — that needs a live Editor with
#   an open project; stop→batchmode→serve is the reliable path under Home Base.
set -euo pipefail

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
mkdir -p "$STATE_DIR"
WATCH_PIDFILE="${STATE_DIR}/live-webgl-watch-$$.pid"
BUILD_LOCK="${STATE_DIR}/webgl-build.lock"

# Resolve port from Home Base action args: live-webgl.sh 8410
export UNITY_WEBGL_PORT="$PORT"
export UNITY_PROJECT="$PROJECT"

stop_bridge_if_ours() {
  if [[ -x "${SCRIPT_DIR}/stop-editor-bridge.sh" ]]; then
    echo "[live-webgl] stopping Coplay bridge for this project (project lock)…"
    UNITY_PROJECT="$PROJECT" bash "${SCRIPT_DIR}/stop-editor-bridge.sh" "$PROJECT" || true
  fi
}

build_once() {
  # flock so watch bursts don't overlap builds
  (
    flock -n 9 || { echo "[live-webgl] build already running — skip"; exit 0; }
    stop_bridge_if_ours
    bash "${SCRIPT_DIR}/build-webgl.sh" "$PROJECT" "$OUT"
  ) 9>"$BUILD_LOCK"
}

if [[ ! -f "$OUT/index.html" ]]; then
  echo "[live-webgl] no build yet — building once…"
  build_once
fi

# Debounced watcher (inotifywait if present, else polling)
watch_loop() {
  echo "[live-webgl] watching Assets Packages ProjectSettings (debounce ${DEBOUNCE_SEC}s)"
  local pending=0
  trigger() {
    pending=1
  }
  (
    if command -v inotifywait >/dev/null 2>&1; then
      inotifywait -m -r -e modify,create,delete,move \
        --exclude '(/Library/|/Temp/|/Logs/|/Builds/|\.git/)' \
        "$PROJECT/Assets" "$PROJECT/Packages" "$PROJECT/ProjectSettings" 2>/dev/null |
      while read -r _; do
        echo "change"
      done
    else
      # Poll mtimes
      local prev=""
      while true; do
        local cur
        cur="$(find "$PROJECT/Assets" "$PROJECT/Packages" "$PROJECT/ProjectSettings" \
          -type f -printf '%T@ %p\n' 2>/dev/null | sort | md5sum | awk '{print $1}')"
        if [[ -n "$prev" && "$cur" != "$prev" ]]; then
          echo "change"
        fi
        prev="$cur"
        sleep 2
      done
    fi
  ) | while read -r _; do
    trigger
    # debounce: wait for quiet period
    while true; do
      pending=0
      sleep "$DEBOUNCE_SEC"
      if [[ "$pending" -eq 0 ]]; then
        echo "[live-webgl] debounced rebuild…"
        build_once || echo "[live-webgl] rebuild failed (see log)"
        break
      fi
    done
  done
}

# Note: pending flag in subshell is imperfect with pipes; use a stamp file debounce.
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
  trap 'kill "$wpid" 2>/dev/null || true; rm -f "$WATCH_PIDFILE" "$stamp"' EXIT

  local last_built=0
  while kill -0 "$wpid" 2>/dev/null; do
    if [[ -f "$stamp" ]]; then
      local t now
      t="$(cat "$stamp" 2>/dev/null || echo 0)"
      now="$(date +%s)"
      if (( now - t >= DEBOUNCE_SEC && t > last_built )); then
        last_built=$now
        rm -f "$stamp"
        echo "[live-webgl] debounced rebuild…"
        build_once || echo "[live-webgl] rebuild failed (see log)"
      fi
    fi
    sleep 1
  done
}

watch_loop_v2 &
WATCH_BG=$!
trap 'kill $WATCH_BG 2>/dev/null || true' EXIT

exec bash "${SCRIPT_DIR}/serve-webgl.sh" "$PORT" "$OUT"
