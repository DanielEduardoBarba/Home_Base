#!/usr/bin/env bash
# =============================================================================
# Home Base · build.sh — setup, project config, run, binary, service, deploy
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

DO_SETUP=false
DO_RUN=false
DO_BIN=false
DO_SERVICE=false
DO_DEPLOY=false
DO_HELP=false
ADD_PRESET=""
ADD_PATH=""
ADD_ID=""
ADD_NAME=""

BIN_OUT_DIR="$ROOT/dist"
BIN_NAME="homebased"
BIN_PATH="$BIN_OUT_DIR/$BIN_NAME"
INSTALL_BIN="/usr/bin/homebased"
SERVICE_NAME="homebased.service"
SERVICE_SRC="$ROOT/packaging/homebased.service"
SERVICE_DST="/etc/systemd/system/$SERVICE_NAME"
HOMEBASE_VAR="/var/lib/homebased"
# Legacy names removed on deploy
LEGACY_BIN="/usr/bin/homebase"
LEGACY_SERVICE="homebase.service"
LEGACY_VAR="/var/lib/homebase"

# Ports: prod :8888 (systemd/root); dev API :8080; Vite :3080 (proxies /api + /ws)
DEV_API_PORT=8080
DEV_WEB_PORT=3080
PROD_PORT=8888

usage() {
  cat <<EOF
Home Base · build.sh

USAGE
  ./build.sh --setup              Install deps, build UI, create .env + token
  ./build.sh --run                Dev: API (uvicorn --reload) + Vite, with hotkeys
  ./build.sh --add-project --preset NAME --path /abs/or/rel/path
  ./build.sh --add-project --path /abs/or/rel/path [--id ID] [--name NAME]
  ./build.sh --bin                Nuitka one-file standalone → dist/homebased
  ./build.sh --service            Install homebased.service, daemon-reload, enable, restart
  ./build.sh --deploy             --bin → cp to /usr/bin/homebased → --service
  ./build.sh -h|--help

Projects live in config/projects.json (gitignored). Presets are templates
(actions/ports only) — always pass --path for where the repo lives.

Deployed binary uses HOMEBASE_HOME=/var/lib/homebased for .env / config / runtime.
Production binds :8888.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup) DO_SETUP=true; shift ;;
    --run) DO_RUN=true; shift ;;
    --bin) DO_BIN=true; shift ;;
    --service) DO_SERVICE=true; shift ;;
    --deploy) DO_DEPLOY=true; shift ;;
    --add-project) shift ;;
    --preset) ADD_PRESET="${2:-}"; shift 2 ;;
    --path) ADD_PATH="${2:-}"; shift 2 ;;
    --id) ADD_ID="${2:-}"; shift 2 ;;
    --name) ADD_NAME="${2:-}"; shift 2 ;;
    -h|--help) DO_HELP=true; shift ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

# If only --preset/--path without other actions, treat as add-project
if [[ "$DO_SETUP" == false && "$DO_RUN" == false && "$DO_HELP" == false \
   && "$DO_BIN" == false && "$DO_SERVICE" == false && "$DO_DEPLOY" == false ]]; then
  if [[ -n "$ADD_PRESET" || -n "$ADD_PATH" ]]; then
    :
  else
    DO_HELP=true
  fi
fi

if [[ "$DO_HELP" == true ]]; then
  usage
  exit 0
fi

need_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then
      echo "sudo"
      return
    fi
    echo "Error: root or sudo required for $1" >&2
    exit 1
  fi
  echo ""
}

run_priv() {
  local wrap
  wrap="$(need_root "$*")"
  if [[ -n "$wrap" ]]; then
    # shellcheck disable=SC2086
    $wrap "$@"
  else
    "$@"
  fi
}

ensure_venv() {
  if [[ ! -d .venv ]]; then
    python3 -m venv .venv
  fi
  # shellcheck disable=SC1091
  source .venv/bin/activate
  pip install -q -r requirements.txt
}

ensure_web_dist() {
  if [[ ! -f web/dist/index.html ]]; then
    echo "==> Building web UI"
    if [[ ! -d web/node_modules ]]; then
      (cd web && npm install)
    fi
    (cd web && npm run build)
  fi
}

cmd_setup() {
  echo "==> Python venv + deps"
  ensure_venv

  echo "==> Frontend deps + production build"
  if [[ ! -d web/node_modules ]]; then
    (cd web && npm install)
  else
    (cd web && npm install --silent)
  fi
  (cd web && npm run build)

  mkdir -p config .runtime/logs dist
  if [[ ! -f config/projects.json ]]; then
    cp config/projects.example.json config/projects.json
    echo "==> Created empty config/projects.json"
  fi

  if [[ ! -f .env ]]; then
    cp .env.example .env
  fi

  local current
  current="$(grep -E '^HOMEBASE_TOKEN=' .env | head -1 | cut -d= -f2- || true)"
  if [[ -z "$current" || "$current" == "change-me-to-a-long-random-string" ]]; then
    local token
    token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
    if grep -qE '^HOMEBASE_TOKEN=' .env; then
      python3 - <<PY
from pathlib import Path
p = Path(".env")
text = p.read_text()
lines = []
for line in text.splitlines():
    if line.startswith("HOMEBASE_TOKEN="):
        lines.append("HOMEBASE_TOKEN=${token}")
    else:
        lines.append(line)
p.write_text("\\n".join(lines) + "\\n")
PY
    else
      echo "HOMEBASE_TOKEN=$token" >> .env
    fi
    echo ""
    echo "=============================================="
    echo "  HOMEBASE_TOKEN generated — save this:"
    echo "  $token"
    echo "=============================================="
    echo "  Paste it once in the web app (remembered)."
    echo ""
  else
    echo "==> HOMEBASE_TOKEN already set in .env"
  fi

  echo ""
  echo "Setup complete."
  echo "  Add projects:  ./build.sh --add-project --preset example --path /path/to/your-repo"
  echo "  Dev console:   ./build.sh --run   (api + vite, hotkeys r/a/w/q/h)"
  echo "  Deploy:        ./build.sh --deploy"
}

cmd_add_project() {
  ensure_venv
  mkdir -p config
  if [[ ! -f config/projects.json ]]; then
    cp config/projects.example.json config/projects.json
  fi

  if [[ -z "$ADD_PATH" ]]; then
    echo "Error: --path is required (presets do not include a default location)." >&2
    echo "  Example: ./build.sh --add-project --preset example --path /path/to/your-repo" >&2
    echo "  Example: ./build.sh --add-project --path /path/to/repo --id myapp" >&2
    if [[ -n "$ADD_PRESET" ]]; then
      echo "  Preset '${ADD_PRESET}' supplies actions/ports only — you choose where it lives." >&2
    fi
    exit 1
  fi

  if [[ ! -d "$ADD_PATH" ]]; then
    echo "Error: path does not exist or is not a directory: $ADD_PATH" >&2
    exit 1
  fi

  local resolved id name
  resolved="$(cd "$ADD_PATH" && pwd)"

  if [[ -n "$ADD_PRESET" ]]; then
    ADD_PRESET="$ADD_PRESET" ADD_PATH="$resolved" ADD_ID="${ADD_ID:-}" ADD_NAME="${ADD_NAME:-}" python3 - <<'PY'
import os, sys
from pathlib import Path
sys.path.insert(0, ".")
from server.config import load_preset, upsert_project
raw = load_preset(os.environ["ADD_PRESET"])
raw.pop("path", None)
raw["path"] = str(Path(os.environ["ADD_PATH"]).resolve())
if os.environ.get("ADD_ID"):
    raw["id"] = os.environ["ADD_ID"]
if os.environ.get("ADD_NAME"):
    raw["name"] = os.environ["ADD_NAME"]
upsert_project(raw)
print(f"Added preset '{os.environ['ADD_PRESET']}': {raw['id']} → {raw['path']}")
PY
    return
  fi

  id="${ADD_ID:-$(basename "$resolved" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')}"
  name="${ADD_NAME:-$(basename "$resolved")}"

  ADD_ID="$id" ADD_NAME="$name" ADD_PATH="$resolved" python3 - <<'PY'
import os, sys
from pathlib import Path
sys.path.insert(0, ".")
from server.config import upsert_project
raw = {
  "id": os.environ["ADD_ID"],
  "name": os.environ["ADD_NAME"],
  "path": str(Path(os.environ["ADD_PATH"]).resolve()),
  "ports": [],
  "actions": [],
}
upsert_project(raw)
print(f"Added project: {raw['id']} → {raw['path']}")
print("Edit config/projects.json to add button → script → args actions.")
PY
}

# ----- --run dev console (concurrently + hotkeys) -----
HOMEBASE_APPS_PID=""
HOMEBASE_EXTRA_PIDS=()
HOMEBASE_CLEANUP_DONE=false
HOTKEY_READY='r/a/w/q/h  (Ctrl+C quit)'

C_BOLD=$'\033[1m'
C_DIM=$'\033[2m'
C_CYAN=$'\033[36m'
C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'
C_WHITE=$'\033[97m'
C_RESET=$'\033[0m'

stop_process_tree() {
  local pid="$1"
  [[ -z "$pid" ]] && return 0
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [[ "$waited" -lt 20 ]]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

pids_on_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$port" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' || true
  fi
}

kill_port() {
  local port="$1"
  local pid
  for pid in $(pids_on_port "$port"); do
    [[ -z "$pid" ]] && continue
    stop_process_tree "$pid"
  done
}

stop_extra_pids() {
  local pid
  for pid in "${HOMEBASE_EXTRA_PIDS[@]:-}"; do
    stop_process_tree "$pid"
  done
  HOMEBASE_EXTRA_PIDS=()
}

have_controlling_tty() {
  { true </dev/tty; } 2>/dev/null
}

print_hotkey_help() {
  cat <<EOF

${C_BOLD}Dev console hotkeys:${C_RESET}
  ${C_WHITE}r${C_RESET}  restart api + web
  ${C_WHITE}a${C_RESET} / ${C_WHITE}q${C_RESET}  restart API only (uvicorn --reload)
  ${C_WHITE}w${C_RESET}  restart web only (Vite)
  ${C_WHITE}h${C_RESET}  show this help
  ${C_YELLOW}Ctrl+C${C_RESET}  quit (stop all processes)

${C_DIM}API${C_RESET}  http://localhost:${HOMEBASE_PORT:-$DEV_API_PORT}   ${C_DIM}Vite${C_RESET}  http://localhost:${DEV_WEB_PORT}
EOF
}

dev_session_alive() {
  if [[ -n "${HOMEBASE_APPS_PID:-}" ]] && kill -0 "$HOMEBASE_APPS_PID" 2>/dev/null; then
    return 0
  fi
  local pid
  for pid in "${HOMEBASE_EXTRA_PIDS[@]:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

api_cmd() {
  local host="${HOMEBASE_HOST:-0.0.0.0}"
  local port="${HOMEBASE_PORT:-$DEV_API_PORT}"
  # bash -lc: concurrently defaults to /bin/sh (no `source`)
  printf 'bash -lc %q' \
    "cd $(printf %q "$ROOT") && . .venv/bin/activate && exec python -m uvicorn server.main:app --host $(printf %q "$host") --port $(printf %q "$port") --reload"
}

web_cmd() {
  printf 'bash -lc %q' \
    "cd $(printf %q "$ROOT/web") && exec npm run dev -- --host 0.0.0.0 --port ${DEV_WEB_PORT}"
}

ensure_concurrently() {
  if [[ ! -d web/node_modules ]]; then
    (cd web && npm install)
  fi
  if [[ ! -x web/node_modules/.bin/concurrently ]]; then
    (cd web && npm install -D concurrently)
  fi
}

spawn_concurrently_dev() {
  ensure_concurrently
  local api_sh web_sh
  api_sh="$(api_cmd)"
  web_sh="$(web_cmd)"

  # No -k: one service dying (or selective restart) must not kill siblings.
  # New session so stop_process_tree can tear down the whole group.
  setsid "$ROOT/web/node_modules/.bin/concurrently" \
    -n api,web -c blue,green \
    "$api_sh" \
    "$web_sh" &
  HOMEBASE_APPS_PID=$!
  echo "[hotkey] stack started (pid ${HOMEBASE_APPS_PID})"
}

spawn_dev_service() {
  local name="$1"
  local cmd="$2"
  setsid bash -lc "echo \"[${name}] starting\"; ${cmd}" &
  HOMEBASE_EXTRA_PIDS+=("$!")
  echo "[hotkey] ${name} started (pid $!)"
}

restart_dev_services() {
  local target="$1"
  case "$target" in
    all)
      echo "[hotkey] r → restart all (api + web)"
      if [[ -n "${HOMEBASE_APPS_PID:-}" ]]; then
        stop_process_tree "$HOMEBASE_APPS_PID"
        HOMEBASE_APPS_PID=""
      fi
      stop_extra_pids
      kill_port "${HOMEBASE_PORT:-$DEV_API_PORT}"
      kill_port "$DEV_WEB_PORT"
      spawn_concurrently_dev
      echo "[hotkey] stack restarted (pid ${HOMEBASE_APPS_PID})"
      ;;
    api)
      echo "[hotkey] → restart API only"
      kill_port "${HOMEBASE_PORT:-$DEV_API_PORT}"
      spawn_dev_service api "$(api_cmd)"
      ;;
    web)
      echo "[hotkey] w → restart web only"
      kill_port "$DEV_WEB_PORT"
      spawn_dev_service web "$(web_cmd)"
      ;;
    *)
      echo "error: unknown restart target: $target" >&2
      return 1
      ;;
  esac
}

watch_dev_hotkeys() {
  if ! have_controlling_tty; then
    wait "${HOMEBASE_APPS_PID}"
    return $?
  fi

  print_hotkey_help

  while dev_session_alive; do
    local key=""
    if ! { IFS= read -r -s -n 1 -t 1 key </dev/tty; } 2>/dev/null; then
      if ! have_controlling_tty; then
        break
      fi
      continue
    fi

    case "$key" in
      r|R)
        echo ""
        restart_dev_services all
        echo "[hotkey] ready (${HOTKEY_READY})"
        ;;
      a|A|q|Q)
        echo ""
        restart_dev_services api
        echo "[hotkey] ready (${HOTKEY_READY})"
        ;;
      w|W)
        echo ""
        restart_dev_services web
        echo "[hotkey] ready (${HOTKEY_READY})"
        ;;
      h|H|'?')
        print_hotkey_help
        ;;
    esac
  done

  wait "${HOMEBASE_APPS_PID}" 2>/dev/null || true
  return 0
}

on_session_exit() {
  if [[ "$HOMEBASE_CLEANUP_DONE" == true ]]; then
    return 0
  fi
  HOMEBASE_CLEANUP_DONE=true
  echo ""
  echo "Stopping Home Base processes (this session only)..."
  if [[ -n "${HOMEBASE_APPS_PID:-}" ]]; then
    stop_process_tree "$HOMEBASE_APPS_PID"
    HOMEBASE_APPS_PID=""
  fi
  stop_extra_pids
  kill_port "${HOMEBASE_PORT:-$DEV_API_PORT}"
  kill_port "$DEV_WEB_PORT"
}

install_session_traps() {
  trap 'on_session_exit' EXIT
  trap 'on_session_exit; exit 130' INT
  trap 'on_session_exit; exit 143' TERM
}

cmd_run() {
  ensure_venv
  if [[ ! -f .env ]]; then
    echo "Missing .env — run ./build.sh --setup first" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  if [[ -z "${HOMEBASE_TOKEN:-}" || "${HOMEBASE_TOKEN}" == "change-me-to-a-long-random-string" ]]; then
    echo "HOMEBASE_TOKEN not set — run ./build.sh --setup" >&2
    exit 1
  fi
  if [[ ! -d web/node_modules ]]; then
    (cd web && npm install)
  fi

  export HOMEBASE_HOST="${HOMEBASE_HOST:-0.0.0.0}"
  export HOMEBASE_PORT="${HOMEBASE_PORT:-$DEV_API_PORT}"

  local lan_ips=""
  if command -v hostname >/dev/null 2>&1; then
    lan_ips="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | head -4 | tr '\n' ' ' || true)"
  fi

  echo ""
  echo "${C_BOLD}Home Base · dev${C_RESET}"
  echo "  ${C_CYAN}API${C_RESET}   http://localhost:${HOMEBASE_PORT}  (uvicorn --host ${HOMEBASE_HOST})"
  echo "  ${C_GREEN}Vite${C_RESET}  http://localhost:${DEV_WEB_PORT}  (proxies /api + /ws → :${HOMEBASE_PORT})"
  if [[ -n "${lan_ips// }" ]]; then
    for ip in $lan_ips; do
      echo "  ${C_GREEN}LAN${C_RESET}   http://${ip}:${DEV_WEB_PORT}  ${C_DIM}(phone / iPad — use Vite, not :${HOMEBASE_PORT})${C_RESET}"
    done
  fi
  echo "  ${C_DIM}UI + API use same-origin /api and /ws (production :${PROD_PORT} also binds 0.0.0.0)${C_RESET}"
  echo ""

  install_session_traps
  # Clear stale listeners from a previous run
  kill_port "$HOMEBASE_PORT"
  kill_port "$DEV_WEB_PORT"
  spawn_concurrently_dev

  if have_controlling_tty; then
    watch_dev_hotkeys
  else
    wait "$HOMEBASE_APPS_PID"
  fi
}

cmd_bin() {
  echo "==> Building Nuitka one-file binary → $BIN_PATH"
  ensure_venv
  ensure_web_dist
  pip install -q "nuitka>=2.4" ordered-set zstandard

  if ! command -v gcc >/dev/null 2>&1 && ! command -v cc >/dev/null 2>&1; then
    echo "Error: gcc/cc required for Nuitka" >&2
    exit 1
  fi

  mkdir -p "$BIN_OUT_DIR"
  rm -f "$BIN_PATH"

  # Onefile standalone; bundle SPA + preset templates.
  python -m nuitka \
    --onefile \
    --standalone \
    --assume-yes-for-downloads \
    --remove-output \
    --output-dir="$BIN_OUT_DIR" \
    --output-filename="$BIN_NAME" \
    --include-package=server \
    --include-package=fastapi \
    --include-package=uvicorn \
    --include-package=starlette \
    --include-package=pydantic \
    --include-package=httpx \
    --include-package=dotenv \
    --include-package=ptyprocess \
    --include-package=websockets \
    --include-package=cursor_sdk \
    --include-data-dir=web/dist=web/dist \
    --include-data-dir=config/presets=config/presets \
    --include-data-files=config/projects.example.json=config/projects.example.json \
    --follow-imports \
    --nofollow-import-to=nuitka \
    --nofollow-import-to=tkinter \
    --nofollow-import-to=unittest \
    homebase_entry.py

  if [[ ! -x "$BIN_PATH" ]]; then
    # Some Nuitka versions nest output
    if [[ -x "$BIN_OUT_DIR/homebase_entry.bin" ]]; then
      mv "$BIN_OUT_DIR/homebase_entry.bin" "$BIN_PATH"
    elif [[ -x "$BIN_OUT_DIR/homebase_entry" ]]; then
      mv "$BIN_OUT_DIR/homebase_entry" "$BIN_PATH"
    fi
  fi

  if [[ ! -x "$BIN_PATH" ]]; then
    echo "Error: binary not found at $BIN_PATH" >&2
    ls -la "$BIN_OUT_DIR" >&2 || true
    exit 1
  fi

  chmod +x "$BIN_PATH"
  echo "==> Binary ready: $BIN_PATH ($(du -h "$BIN_PATH" | cut -f1))"
}

force_prod_port_in_env() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  # Production always binds :8888 — rewrite any copied dev HOMEBASE_PORT=8080.
  if run_priv grep -qE '^HOMEBASE_PORT=' "$env_file" 2>/dev/null; then
    run_priv sed -i "s/^HOMEBASE_PORT=.*/HOMEBASE_PORT=${PROD_PORT}/" "$env_file"
  else
    run_priv bash -c "echo 'HOMEBASE_PORT=${PROD_PORT}' >> $(printf %q "$env_file")"
  fi
}

migrate_legacy_var() {
  if [[ -d "$LEGACY_VAR" ]] && [[ ! -d "$HOMEBASE_VAR" ]]; then
    echo "==> Migrating $LEGACY_VAR → $HOMEBASE_VAR"
    run_priv mv "$LEGACY_VAR" "$HOMEBASE_VAR"
  elif [[ -d "$LEGACY_VAR" ]] && [[ -d "$HOMEBASE_VAR" ]]; then
    echo "==> Removing leftover $LEGACY_VAR (already have $HOMEBASE_VAR)"
    run_priv rm -rf "$LEGACY_VAR"
  fi
}

remove_legacy_install() {
  echo "==> Removing legacy homebase install"
  if systemctl list-unit-files "$LEGACY_SERVICE" &>/dev/null; then
    run_priv systemctl disable --now "$LEGACY_SERVICE" 2>/dev/null || true
  fi
  run_priv rm -f "/etc/systemd/system/$LEGACY_SERVICE"
  run_priv rm -f "$LEGACY_BIN"
  # Also drop any leftover binary named homebase under dist
  rm -f "$BIN_OUT_DIR/homebase" 2>/dev/null || true
}

free_prod_port() {
  echo "==> Freeing production port $PROD_PORT"
  local pid
  for pid in $(pids_on_port "$PROD_PORT"); do
    echo "    killing pid $pid on :$PROD_PORT"
    run_priv kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 0.5
  for pid in $(pids_on_port "$PROD_PORT"); do
    run_priv kill -KILL "$pid" 2>/dev/null || true
  done
}

prepare_var_lib() {
  migrate_legacy_var
  echo "==> Preparing $HOMEBASE_VAR"
  run_priv mkdir -p "$HOMEBASE_VAR/config" "$HOMEBASE_VAR/.runtime/logs"
  if [[ -f .env ]] && [[ ! -f "$HOMEBASE_VAR/.env" ]]; then
    run_priv cp .env "$HOMEBASE_VAR/.env"
    echo "    copied .env → $HOMEBASE_VAR/.env"
  fi
  if [[ -f "$HOMEBASE_VAR/.env" ]]; then
    force_prod_port_in_env "$HOMEBASE_VAR/.env"
    echo "    set HOMEBASE_PORT=$PROD_PORT in $HOMEBASE_VAR/.env"
  fi
  if [[ -f config/projects.json ]] && [[ ! -f "$HOMEBASE_VAR/config/projects.json" ]]; then
    run_priv cp config/projects.json "$HOMEBASE_VAR/config/projects.json"
    echo "    copied config/projects.json"
  elif [[ ! -f "$HOMEBASE_VAR/config/projects.json" ]]; then
    run_priv cp config/projects.example.json "$HOMEBASE_VAR/config/projects.json"
  fi
}

stop_homebased() {
  # Must stop before replacing /usr/bin/homebased — Linux returns ETXTBSY ("Text file busy")
  # when cp overwrites an executable that is still mapped/running.
  if systemctl list-unit-files "$SERVICE_NAME" &>/dev/null; then
    run_priv systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  fi
  if systemctl list-unit-files "$LEGACY_SERVICE" &>/dev/null; then
    run_priv systemctl stop "$LEGACY_SERVICE" 2>/dev/null || true
  fi
  # Ensure no leftover process holds the inode
  local waited=0
  while pgrep -x homebased >/dev/null 2>&1 || pgrep -x homebase >/dev/null 2>&1; do
    if [[ "$waited" -ge 30 ]]; then
      run_priv pkill -KILL -x homebased 2>/dev/null || true
      run_priv pkill -KILL -x homebase 2>/dev/null || true
      break
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
}

install_binary() {
  if [[ ! -x "$BIN_PATH" ]]; then
    echo "Error: missing binary $BIN_PATH — run ./build.sh --bin first" >&2
    exit 1
  fi
  echo "==> Installing binary → $INSTALL_BIN"
  stop_homebased
  # Atomic replace: write beside target then mv (avoids ETXTBSY even if something races)
  run_priv cp "$BIN_PATH" "${INSTALL_BIN}.new"
  run_priv chmod 755 "${INSTALL_BIN}.new"
  run_priv mv -f "${INSTALL_BIN}.new" "$INSTALL_BIN"
}

port_is_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null | grep -F ":${port}" >/dev/null
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  return 1
}

wait_for_listen() {
  local port="$1"
  local i
  for i in $(seq 1 40); do
    if port_is_listening "$port"; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

cmd_service() {
  echo "==> Installing $SERVICE_NAME"
  if [[ ! -f "$SERVICE_SRC" ]]; then
    echo "Error: missing $SERVICE_SRC" >&2
    exit 1
  fi
  if [[ -x "$BIN_PATH" ]]; then
    # Refresh /usr/bin from dist when available (covers failed mid-deploy ETXTBSY retries)
    install_binary
  elif [[ ! -x "$INSTALL_BIN" ]]; then
    echo "Error: $INSTALL_BIN not found — run ./build.sh --bin or ./build.sh --deploy" >&2
    exit 1
  fi

  remove_legacy_install
  free_prod_port
  prepare_var_lib
  run_priv cp "$SERVICE_SRC" "$SERVICE_DST"
  run_priv systemctl daemon-reload
  run_priv systemctl enable "$SERVICE_NAME"
  run_priv systemctl restart "$SERVICE_NAME"
  run_priv systemctl --no-pager --full status "$SERVICE_NAME" || true
  if wait_for_listen "$PROD_PORT"; then
    echo "==> Listening on :$PROD_PORT — open http://localhost:${PROD_PORT}/"
  else
    echo "Warning: nothing listening on :$PROD_PORT yet — check: journalctl -u $SERVICE_NAME -n 50" >&2
  fi
  echo "==> Service $SERVICE_NAME enabled and restarted"
  echo "    HOMEBASE_HOME=$HOMEBASE_VAR  binary=$INSTALL_BIN  port=$PROD_PORT"
}

cmd_deploy() {
  echo "==> Deploy: build binary → install /usr/bin → systemd"
  cmd_bin
  install_binary
  cmd_service
  echo "==> Deploy complete → http://0.0.0.0:${PROD_PORT} as root (see $HOMEBASE_VAR/.env)"
}

if [[ "$DO_SETUP" == true ]]; then
  cmd_setup
fi

if [[ -n "$ADD_PRESET" || -n "$ADD_PATH" ]]; then
  cmd_add_project
fi

if [[ "$DO_DEPLOY" == true ]]; then
  cmd_deploy
elif [[ "$DO_BIN" == true ]]; then
  cmd_bin
  if [[ "$DO_SERVICE" == true ]]; then
    install_binary
    cmd_service
  fi
elif [[ "$DO_SERVICE" == true ]]; then
  cmd_service
fi

if [[ "$DO_RUN" == true ]]; then
  cmd_run
fi
