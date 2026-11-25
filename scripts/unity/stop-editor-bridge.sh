#!/usr/bin/env bash
# Stop the Home Base Unity MCP bridge Editor for a project path.
set -euo pipefail

if [[ -n "${1:-}" ]]; then
  PROJECT="$1"
elif [[ -n "${UNITY_PROJECT:-}" ]]; then
  PROJECT="$UNITY_PROJECT"
elif [[ -f "${PWD}/ProjectSettings/ProjectVersion.txt" ]]; then
  PROJECT="$PWD"
else
  PROJECT="${HOME}/MCP_WORKSPACES/unity-sample"
fi
PIDFILE="${UNITY_BRIDGE_PIDFILE:-${HOME}/.cache/homebase-unity/bridge.pid}"
BRIDGE_PORT="${UNITY_MCP_PORT:-6400}"

stopped=0

if [[ -f "$PIDFILE" ]]; then
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "${pid}" ]] && kill -0 "$pid" 2>/dev/null; then
    if tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q -- "-projectPath ${PROJECT}"; then
      kill "$pid" 2>/dev/null || true
      # Give Unity a moment to exit cleanly
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
      stopped=1
      echo "Stopped Unity PID $pid"
    fi
  fi
  rm -f "$PIDFILE"
fi

# Fallback: match by project path (never kill unrelated Editors)
while read -r pid; do
  [[ -n "$pid" ]] || continue
  kill "$pid" 2>/dev/null || true
  stopped=1
  echo "Stopped Unity PID $pid (project match)"
done < <(pgrep -f "Unity.*-projectPath ${PROJECT}" || true)

if (( stopped == 0 )); then
  echo "No bridge Editor running for $PROJECT"
else
  # Brief wait for port release
  sleep 1
fi

if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -qE ":${BRIDGE_PORT}[[:space:]]"; then
    echo "note: port ${BRIDGE_PORT} still listening (another instance may own it)"
  else
    echo "port ${BRIDGE_PORT} is free"
  fi
fi
