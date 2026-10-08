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
# Binary + /usr/bin wrapper are homebase; systemd unit stays homebased.service.
BIN_NAME="homebase"
BIN_PATH="$BIN_OUT_DIR/$BIN_NAME"
INSTALL_SHARE="/usr/share/homebased"
INSTALL_BIN_REAL="$INSTALL_SHARE/homebase"
INSTALL_BIN_BAK="$INSTALL_SHARE/homebase.bak"
# Older deploys used homebased as the share binary / wrapper name
LEGACY_SHARE_BIN="$INSTALL_SHARE/homebased"
LEGACY_SHARE_BAK="$INSTALL_SHARE/homebased.bak"
LEGACY_WRAPPER="/usr/bin/homebased"
INSTALL_WRAPPER="/usr/bin/homebase"
WRAPPER_SRC="$ROOT/packaging/homebased-wrapper.sh"
# Back-compat name used in messages
INSTALL_BIN="$INSTALL_WRAPPER"
SERVICE_NAME="homebased.service"
SERVICE_SRC="$ROOT/packaging/homebased.service"
SERVICE_DST="/etc/systemd/system/$SERVICE_NAME"
HOMEBASE_VAR="/var/lib/homebased"
VERSION_FILE="$ROOT/VERSION"
# Pre-homebased unit name (removed on deploy)
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
  ./build.sh --setup              Install deps, build UI, create .env + JWT secret
  ./build.sh --run                Dev: API (uvicorn --reload) + Vite, with hotkeys
  ./build.sh --add-project --preset NAME --path /abs/or/rel/path
  ./build.sh --add-project --path /abs/or/rel/path [--id ID] [--name NAME]
  ./build.sh --bin                Nuitka one-file standalone → dist/homebase
  ./build.sh --service            Install homebased.service, daemon-reload, enable, restart
  ./build.sh --deploy             --bin → safe install under /usr/share + wrapper → --service
  ./build.sh -h|--help

Projects live in config/projects.json (gitignored). Presets are templates
(actions/ports only) — always pass --path for where the repo lives.

Deployed layout:
  /usr/share/homebased/homebase       active binary (root:root 755)
  /usr/share/homebased/homebase.bak   last known-good
  /usr/bin/homebase                   wrapper (self-test → exec, else backup)
  homebased.service                   systemd unit → /usr/bin/homebase
  HOMEBASE_HOME=/var/lib/homebased    .env / config / runtime (root:root)
  dist/homebase                       always reclaimed to the workspace user
Safe as you (sudo) or root — ownership is normalized each deploy.
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

# Repo / dist owner: SUDO_USER when elevated, else filesystem owner of ROOT, else self.
workspace_owner() {
  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    echo "$SUDO_USER"
    return
  fi
  if [[ "$(id -u)" -eq 0 ]]; then
    stat -c '%U' "$ROOT" 2>/dev/null || echo root
    return
  fi
  id -un
}

workspace_group() {
  local u
  u="$(workspace_owner)"
  id -gn "$u" 2>/dev/null || echo "$u"
}

# Ensure dist/ is writable for the current build; leave it owned by the workspace user
# so root deploys do not brick the next non-root ./build.sh --bin.
ensure_dist_writable() {
  local owner group
  owner="$(workspace_owner)"
  group="$(workspace_group)"
  if [[ ! -d "$BIN_OUT_DIR" ]]; then
    mkdir -p "$BIN_OUT_DIR" 2>/dev/null || run_priv mkdir -p "$BIN_OUT_DIR"
  fi
  if [[ ! -w "$BIN_OUT_DIR" ]] || { [[ -e "$BIN_PATH" ]] && [[ ! -w "$BIN_PATH" ]]; }; then
    echo "    reclaiming $BIN_OUT_DIR → ${owner}:${group}"
    run_priv chown -R "${owner}:${group}" "$BIN_OUT_DIR"
  fi
}

claim_dist_to_workspace() {
  local owner group
  owner="$(workspace_owner)"
  group="$(workspace_group)"
  [[ -d "$BIN_OUT_DIR" ]] || return 0
  if [[ "$(id -u)" -eq 0 ]]; then
    chown -R "${owner}:${group}" "$BIN_OUT_DIR"
  elif [[ -e "$BIN_PATH" ]] && [[ ! -O "$BIN_PATH" ]]; then
    run_priv chown -R "${owner}:${group}" "$BIN_OUT_DIR"
  fi
  if [[ -e "$BIN_PATH" ]]; then
    chmod 755 "$BIN_PATH" 2>/dev/null || run_priv chmod 755 "$BIN_PATH"
  fi
}

# Installed system paths always root:root so both user (sudo) and root deploys converge.
secure_install_ownership() {
  run_priv bash -c "
    set -e
    mkdir -p $(printf %q "$INSTALL_SHARE")
    chown root:root $(printf %q "$INSTALL_SHARE")
    chmod 755 $(printf %q "$INSTALL_SHARE")
    for f in \
      $(printf %q "$INSTALL_BIN_REAL") \
      $(printf %q "$INSTALL_BIN_BAK") \
      $(printf %q "$INSTALL_WRAPPER") \
      $(printf %q "$INSTALL_SHARE/VERSION") \
      $(printf %q "$INSTALL_SHARE/.running-backup"); do
      [[ -e \"\$f\" ]] || continue
      chown root:root \"\$f\"
    done
    [[ -e $(printf %q "$INSTALL_BIN_REAL") ]] && chmod 755 $(printf %q "$INSTALL_BIN_REAL")
    [[ -e $(printf %q "$INSTALL_BIN_BAK") ]] && chmod 755 $(printf %q "$INSTALL_BIN_BAK")
    [[ -e $(printf %q "$INSTALL_WRAPPER") ]] && chmod 755 $(printf %q "$INSTALL_WRAPPER")
    [[ -e $(printf %q "$INSTALL_SHARE/VERSION") ]] && chmod 644 $(printf %q "$INSTALL_SHARE/VERSION")
  "
}

secure_var_ownership() {
  run_priv bash -c "
    set -e
    mkdir -p \
      $(printf %q "$HOMEBASE_VAR/config") \
      $(printf %q "$HOMEBASE_VAR/.runtime/logs")
    chown -R root:root $(printf %q "$HOMEBASE_VAR")
    chmod 755 \
      $(printf %q "$HOMEBASE_VAR") \
      $(printf %q "$HOMEBASE_VAR/config") \
      $(printf %q "$HOMEBASE_VAR/.runtime") \
      $(printf %q "$HOMEBASE_VAR/.runtime/logs") || true
    [[ -f $(printf %q "$HOMEBASE_VAR/.env") ]] && chmod 600 $(printf %q "$HOMEBASE_VAR/.env")
    [[ -f $(printf %q "$HOMEBASE_VAR/config/projects.json") ]] && \
      chmod 644 $(printf %q "$HOMEBASE_VAR/config/projects.json")
    for secret in jwt_secret auth.json; do
      f=$(printf %q "$HOMEBASE_VAR/.runtime")/\$secret
      [[ -f \"\$f\" ]] && chmod 600 \"\$f\"
    done
  "
}

# Probe must work as the invoking user (sudo deploy) or as root. Temp HOME + TMPDIR
# keep jwt/runtime and Nuitka onefile unpack off /var/lib and /usr/share.
probe_bin() {
  local target="$1"
  local tmp rc
  [[ -x "$target" ]] || return 1
  tmp="$(mktemp -d /tmp/homebased-probe.XXXXXX)"
  set +e
  TMPDIR="$tmp" HOMEBASE_SELF_TEST=1 HOMEBASE_HOME="$tmp" HOMEBASE_RUNTIME="$tmp/.runtime" \
    "$target" >/dev/null 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    set +e
    run_priv env TMPDIR="$tmp" HOMEBASE_SELF_TEST=1 \
      HOMEBASE_HOME="$tmp" HOMEBASE_RUNTIME="$tmp/.runtime" \
      "$target" >/dev/null 2>&1
    rc=$?
    set -e
  fi
  rm -rf "$tmp" 2>/dev/null || true
  return "$rc"
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
    build_web_dist
  fi
}

# Always rebuild SPA (deploy / --bin must ship current UI, not a stale web/dist).
build_web_dist() {
  echo "==> Building web UI"
  if [[ ! -d web/node_modules ]]; then
    (cd web && npm install)
  fi
  (cd web && npm run build)
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

  # Ensure JWT signing material exists (password is set later via localhost UI)
  .venv/bin/python -c "from server.auth import jwt_secret; jwt_secret(); print('JWT secret ready')"

  # Drop legacy HOMEBASE_TOKEN from .env if present (auth is password → JWT now)
  if grep -qE '^HOMEBASE_TOKEN=' .env 2>/dev/null; then
    python3 - <<'PY'
from pathlib import Path
p = Path(".env")
lines = [ln for ln in p.read_text().splitlines() if not ln.startswith("HOMEBASE_TOKEN=")]
p.write_text("\n".join(lines) + ("\n" if lines else ""))
print("Removed legacy HOMEBASE_TOKEN from .env")
PY
  fi

  echo ""
  echo "Setup complete."
  echo "  Open UI on localhost → create a password (only localhost can set/change it)."
  echo "  Sessions are JWT with 24h TTL. Share QR issues a one-time redeem code."
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
  build_web_dist
  pip install -q "nuitka>=2.4" ordered-set zstandard

  if ! command -v gcc >/dev/null 2>&1 && ! command -v cc >/dev/null 2>&1; then
    echo "Error: gcc/cc required for Nuitka" >&2
    exit 1
  fi

  ensure_dist_writable
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
    --include-data-files=VERSION=VERSION \
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

  chmod +x "$BIN_PATH" 2>/dev/null || run_priv chmod +x "$BIN_PATH"
  claim_dist_to_workspace
  echo "==> Binary ready: $BIN_PATH ($(du -h "$BIN_PATH" | cut -f1)) [$(workspace_owner):$(workspace_group)]"
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

# Merge selected keys from repo .env → /var/lib/homebased/.env so VPN/prod
# picks up CURSOR_API_KEY and friends that only lived in the dev tree.
sync_env_key_from_repo() {
  local key="$1"
  local src=".env"
  local dest="$HOMEBASE_VAR/.env"
  [[ -f "$src" ]] || return 0
  [[ -f "$dest" ]] || return 0
  local val
  val="$(grep -E "^${key}=" "$src" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  [[ -n "$val" ]] || return 0
  # Always push non-empty repo values into prod (fixes VPN Cursor when key only lived in dev .env)
  if run_priv grep -qE "^${key}=" "$dest" 2>/dev/null; then
    run_priv sed -i "s|^${key}=.*|${key}=${val}|" "$dest"
  else
    run_priv bash -c "printf '%s=%s\n' $(printf %q "$key") $(printf %q "$val") >> $(printf %q "$dest")"
  fi
  echo "    synced $key → $dest"
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
  echo "==> Removing legacy homebase.service (if present)"
  if systemctl list-unit-files "$LEGACY_SERVICE" &>/dev/null; then
    run_priv systemctl disable --now "$LEGACY_SERVICE" 2>/dev/null || true
  fi
  run_priv rm -f "/etc/systemd/system/$LEGACY_SERVICE"
  # Drop old share binary names after migrate (homebased → homebase)
  if [[ -x "$INSTALL_BIN_REAL" ]]; then
    run_priv rm -f "$LEGACY_SHARE_BIN" "$LEGACY_SHARE_BAK"
  fi
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
    # VPN/prod uses this file — keep Cursor key in sync from the repo .env
    sync_env_key_from_repo "CURSOR_API_KEY"
    sync_env_key_from_repo "CURSOR_MODEL"
    sync_env_key_from_repo "HOMEBASE_JWT_SECRET"
  fi
  # Deploy machine is source of truth for project registry
  if [[ -f config/projects.json ]]; then
    run_priv cp config/projects.json "$HOMEBASE_VAR/config/projects.json"
    echo "    synced config/projects.json → $HOMEBASE_VAR/config/"
  elif [[ ! -f "$HOMEBASE_VAR/config/projects.json" ]]; then
    run_priv cp config/projects.example.json "$HOMEBASE_VAR/config/projects.json"
    echo "    seeded config/projects.json from example"
  fi
  # Keep Run + Expo as compose (two PTYs) even on older prod projects.json
  if [[ -f "$HOMEBASE_VAR/config/projects.json" ]]; then
    run_priv python3 - <<'PY' || echo "    warning: compose upgrade skipped" >&2
import json
from pathlib import Path
path = Path("/var/lib/homebased/config/projects.json")
data = json.loads(path.read_text())
compose = {
    "id": "run_all",
    "label": "Run + Expo",
    "type": "compose",
    "compose": ["run", "expo"],
    "variant": "accent",
    "group": "main",
}
changed = False
for p in data.get("projects") or []:
    actions = p.get("actions") or []
    for i, a in enumerate(actions):
        if a.get("id") == "run_all" and (
            a.get("type") != "compose" or a.get("compose") != ["run", "expo"]
        ):
            actions[i] = {**a, **compose}
            changed = True
    p["actions"] = actions
if changed:
    path.write_text(json.dumps(data, indent=2) + "\n")
    print("    upgraded run_all → compose (run + expo)")
PY
  fi
  secure_var_ownership
}

# Set after we stop the unit so EXIT trap can bring it back if deploy aborts.
HOMEBASED_UNIT_STOPPED=0
INSTALL_USED_BACKUP=0

ensure_homebased_running_on_exit() {
  if [[ "${HOMEBASED_UNIT_STOPPED}" != "1" ]]; then
    return 0
  fi
  echo "==> Deploy interrupted — starting $SERVICE_NAME again" >&2
  run_priv systemctl start "$SERVICE_NAME" 2>/dev/null \
    || run_priv systemctl restart "$SERVICE_NAME" 2>/dev/null \
    || true
}

stop_homebased() {
  # Must stop before replacing binaries — Linux returns ETXTBSY ("Text file busy")
  # when cp overwrites an executable that is still mapped/running.
  if systemctl list-unit-files "$SERVICE_NAME" &>/dev/null; then
    run_priv systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    HOMEBASED_UNIT_STOPPED=1
  fi
  if systemctl list-unit-files "$LEGACY_SERVICE" &>/dev/null; then
    run_priv systemctl stop "$LEGACY_SERVICE" 2>/dev/null || true
  fi
  # Ensure no leftover process holds the inode
  local waited=0
  while pgrep -x homebase >/dev/null 2>&1 || pgrep -x homebased >/dev/null 2>&1; do
    if [[ "$waited" -ge 30 ]]; then
      run_priv pkill -KILL -x homebase 2>/dev/null || true
      run_priv pkill -KILL -x homebased 2>/dev/null || true
      break
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
}

# Install unit file, enable, restart, and verify active + :8888.
# Always the last step of --deploy / --service — never skip.
restart_homebased_service() {
  echo "==> Restarting $SERVICE_NAME"
  run_priv cp "$SERVICE_SRC" "$SERVICE_DST"
  run_priv systemctl daemon-reload
  run_priv systemctl enable "$SERVICE_NAME"
  run_priv systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true
  if ! run_priv systemctl restart "$SERVICE_NAME"; then
    echo "Error: systemctl restart $SERVICE_NAME failed" >&2
    run_priv journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2 || true
    return 1
  fi
  local i
  for i in $(seq 1 40); do
    if run_priv systemctl is-active --quiet "$SERVICE_NAME"; then
      break
    fi
    sleep 0.25
  done
  if ! run_priv systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "Error: $SERVICE_NAME is not active after restart" >&2
    run_priv systemctl --no-pager --full status "$SERVICE_NAME" >&2 || true
    run_priv journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2 || true
    return 1
  fi
  HOMEBASED_UNIT_STOPPED=0
  run_priv systemctl --no-pager --full status "$SERVICE_NAME" || true
  if wait_for_listen "$PROD_PORT"; then
    echo "==> $SERVICE_NAME active — http://localhost:${PROD_PORT}/"
  else
    echo "Warning: $SERVICE_NAME is active but nothing on :$PROD_PORT yet — journalctl -u $SERVICE_NAME -n 50" >&2
  fi
  echo "==> Service $SERVICE_NAME enabled and restarted"
  echo "    HOMEBASE_HOME=$HOMEBASE_VAR  binary=$INSTALL_BIN → $INSTALL_BIN_REAL  port=$PROD_PORT"
  return 0
}

install_binary() {
  if [[ ! -x "$BIN_PATH" ]]; then
    echo "Error: missing binary $BIN_PATH — run ./build.sh --bin first" >&2
    exit 1
  fi
  if [[ ! -f "$WRAPPER_SRC" ]]; then
    echo "Error: missing wrapper $WRAPPER_SRC" >&2
    exit 1
  fi
  # Root builds leave root-owned dist/; reclaim so cp source is readable and next
  # non-root build can overwrite. Install targets are always root:root below.
  claim_dist_to_workspace
  echo "==> Safe install → $INSTALL_BIN_REAL (+ wrapper $INSTALL_WRAPPER / $SERVICE_NAME)"
  stop_homebased
  run_priv mkdir -p "$INSTALL_SHARE"
  run_priv chown root:root "$INSTALL_SHARE"
  run_priv chmod 755 "$INSTALL_SHARE"

  # Rename share binary homebased → homebase (keep .bak continuity)
  if [[ ! -x "$INSTALL_BIN_REAL" ]] && [[ -x "$LEGACY_SHARE_BIN" ]]; then
    echo "    migrating $LEGACY_SHARE_BIN → $INSTALL_BIN_REAL"
    run_priv mv -f "$LEGACY_SHARE_BIN" "$INSTALL_BIN_REAL"
  fi
  if [[ ! -x "$INSTALL_BIN_BAK" ]] && [[ -x "$LEGACY_SHARE_BAK" ]]; then
    echo "    migrating $LEGACY_SHARE_BAK → $INSTALL_BIN_BAK"
    run_priv mv -f "$LEGACY_SHARE_BAK" "$INSTALL_BIN_BAK"
  fi

  # Migrate fat binary formerly at /usr/bin/homebase(d) into the share layout once
  for candidate in "$LEGACY_WRAPPER" "$INSTALL_WRAPPER"; do
    if [[ ! -x "$INSTALL_BIN_REAL" ]] && [[ -x "$candidate" ]]; then
      if ! head -n1 "$candidate" 2>/dev/null | grep -qE 'bash|sh'; then
        echo "    migrating fat $candidate → $INSTALL_BIN_REAL"
        run_priv cp -f "$candidate" "$INSTALL_BIN_REAL"
        run_priv chmod 755 "$INSTALL_BIN_REAL"
        break
      fi
    fi
  done

  local ver="0.0.0" prev_ver=""
  if [[ -f "$VERSION_FILE" ]]; then
    ver="$(head -n1 "$VERSION_FILE" | tr -d '[:space:]')"
  fi
  if [[ -f "$INSTALL_SHARE/VERSION" ]]; then
    prev_ver="$(run_priv head -n1 "$INSTALL_SHARE/VERSION" 2>/dev/null | tr -d '[:space:]' || true)"
  fi

  # Always park the currently deployed primary as .bak, then put the new build in place.
  # (Do not call this twice in one deploy — that would bak the new binary over the old.)
  if [[ -x "$INSTALL_BIN_REAL" ]]; then
    echo "    previous → .bak${prev_ver:+ (v${prev_ver})}"
    run_priv cp -f "$INSTALL_BIN_REAL" "$INSTALL_BIN_BAK"
    run_priv chmod 755 "$INSTALL_BIN_BAK"
    if [[ -f "$INSTALL_SHARE/VERSION" ]]; then
      run_priv cp -f "$INSTALL_SHARE/VERSION" "$INSTALL_SHARE/VERSION.bak"
    fi
  else
    echo "    no previous binary — first install (no .bak yet)"
  fi

  # Atomic install of new binary as primary
  run_priv cp "$BIN_PATH" "${INSTALL_BIN_REAL}.new"
  run_priv chmod 755 "${INSTALL_BIN_REAL}.new"
  run_priv mv -f "${INSTALL_BIN_REAL}.new" "$INSTALL_BIN_REAL"
  run_priv cp "$VERSION_FILE" "$INSTALL_SHARE/VERSION" 2>/dev/null || \
    run_priv bash -c "printf '%s\n' $(printf %q "$ver") > $(printf %q "$INSTALL_SHARE/VERSION")"
  run_priv rm -f "$INSTALL_SHARE/.running-backup"

  # Install / refresh wrapper at /usr/bin/homebase; drop old /usr/bin/homebased name
  run_priv cp "$WRAPPER_SRC" "${INSTALL_WRAPPER}.new"
  run_priv chmod 755 "${INSTALL_WRAPPER}.new"
  run_priv mv -f "${INSTALL_WRAPPER}.new" "$INSTALL_WRAPPER"
  if [[ -e "$LEGACY_WRAPPER" ]]; then
    echo "    removing legacy wrapper $LEGACY_WRAPPER"
    run_priv rm -f "$LEGACY_WRAPPER"
  fi

  secure_install_ownership

  # Probe new primary; if it fails, restore .bak so systemd can still start.
  # Never exit here — caller must still restart homebased.service.
  INSTALL_USED_BACKUP=0
  if ! probe_bin "$INSTALL_BIN_REAL"; then
    echo "    NEW binary failed self-test" >&2
    tmp="$(mktemp -d /tmp/homebased-probe.XXXXXX)"
    TMPDIR="$tmp" HOMEBASE_SELF_TEST=1 HOMEBASE_HOME="$tmp" HOMEBASE_RUNTIME="$tmp/.runtime" \
      "$INSTALL_BIN_REAL" 2>&1 | tail -n 5 || \
      run_priv env TMPDIR="$tmp" HOMEBASE_SELF_TEST=1 HOMEBASE_HOME="$tmp" \
        HOMEBASE_RUNTIME="$tmp/.runtime" "$INSTALL_BIN_REAL" 2>&1 | tail -n 5 || true
    rm -rf "$tmp" 2>/dev/null || true
    if [[ -x "$INSTALL_BIN_BAK" ]]; then
      echo "    restoring .bak as active binary" >&2
      run_priv cp -f "$INSTALL_BIN_BAK" "$INSTALL_BIN_REAL"
      if [[ -f "$INSTALL_SHARE/VERSION.bak" ]]; then
        run_priv cp -f "$INSTALL_SHARE/VERSION.bak" "$INSTALL_SHARE/VERSION"
      fi
      run_priv bash -c "echo 1 > $(printf %q "$INSTALL_SHARE/.running-backup")"
      secure_install_ownership
      INSTALL_USED_BACKUP=1
    else
      echo "    warning: no .bak — primary may be broken; will still try to start service" >&2
      INSTALL_USED_BACKUP=1
    fi
  else
    echo "    primary v${ver} (previous${prev_ver:+ v${prev_ver}} kept as .bak)"
  fi
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

# Nuitka omits cursor_sdk/_vendor/bridge (~180MB node tree). Copy it next to the
# binary and point CURSOR_SDK_BRIDGE_BIN at the launcher for prod Cursor chat.
# Never abort deploy — Cursor chat can fail soft; systemd must still restart.
install_cursor_bridge() {
  local src="" dest launcher env_file
  dest="$INSTALL_SHARE/cursor-sdk-bridge"
  launcher="$dest/bin/cursor-sdk-bridge"
  if [[ -d .venv/lib ]]; then
    src="$(find .venv/lib -path '*/cursor_sdk/_vendor/bridge' -type d 2>/dev/null | head -n1 || true)"
  fi
  if [[ -z "$src" || ! -f "$src/bin/cursor-sdk-bridge" ]]; then
    echo "    warning: cursor-sdk bridge not in .venv — Cursor chat may fail until ./build.sh --setup" >&2
    return 0
  fi
  echo "==> Installing cursor-sdk bridge → $dest"
  set +e
  run_priv rm -rf "$dest"
  run_priv mkdir -p "$INSTALL_SHARE"
  run_priv cp -a "$src" "$dest"
  local rc=$?
  run_priv chmod 755 "$dest/bin/cursor-sdk-bridge" 2>/dev/null
  run_priv chmod 755 "$dest/bin/node" 2>/dev/null
  set -e
  if [[ "$rc" -ne 0 || ! -f "$launcher" ]]; then
    echo "    warning: bridge install failed — continuing so $SERVICE_NAME still restarts" >&2
    return 0
  fi
  env_file="$HOMEBASE_VAR/.env"
  run_priv mkdir -p "$HOMEBASE_VAR"
  if [[ ! -f "$env_file" ]]; then
    run_priv touch "$env_file"
    run_priv chmod 600 "$env_file"
  fi
  if run_priv grep -qE '^CURSOR_SDK_BRIDGE_BIN=' "$env_file" 2>/dev/null; then
    run_priv sed -i "s|^CURSOR_SDK_BRIDGE_BIN=.*|CURSOR_SDK_BRIDGE_BIN=${launcher}|" "$env_file"
  else
    run_priv bash -c "printf 'CURSOR_SDK_BRIDGE_BIN=%s\n' $(printf %q "$launcher") >> $(printf %q "$env_file")"
  fi
  echo "    CURSOR_SDK_BRIDGE_BIN=$launcher"
}

cmd_service() {
  echo "==> Installing $SERVICE_NAME"
  if [[ ! -f "$SERVICE_SRC" ]]; then
    echo "Error: missing $SERVICE_SRC" >&2
    exit 1
  fi
  trap ensure_homebased_running_on_exit EXIT

  INSTALL_USED_BACKUP=0
  if [[ -x "$BIN_PATH" ]]; then
    # Refresh share binary + wrapper from dist (once per deploy/service)
    install_binary
  elif [[ ! -x "$INSTALL_BIN_REAL" ]] && [[ ! -x "$INSTALL_WRAPPER" ]]; then
    echo "Error: no binary at $BIN_PATH or $INSTALL_BIN_REAL — run ./build.sh --bin or ./build.sh --deploy" >&2
    exit 1
  else
    echo "    using existing install at $INSTALL_BIN_REAL (no new dist/ binary)"
  fi

  remove_legacy_install
  free_prod_port
  prepare_var_lib
  install_cursor_bridge

  if ! restart_homebased_service; then
    exit 1
  fi
  trap - EXIT

  if [[ "${INSTALL_USED_BACKUP:-0}" == "1" ]] || [[ -f "$INSTALL_SHARE/.running-backup" ]]; then
    echo "    WARNING: running BACKUP binary — new build failed self-test; fix and redeploy" >&2
    exit 1
  fi
}

cmd_deploy() {
  echo "==> Deploy: build → install homebase binary → restart homebased.service"
  cmd_bin
  # install_binary runs once inside cmd_service (avoid double-install, which
  # would copy the NEW primary over .bak and lose the real previous binary)
  cmd_service
  echo "==> Deploy complete → http://0.0.0.0:${PROD_PORT}/ ($SERVICE_NAME)"
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
    cmd_service
  fi
elif [[ "$DO_SERVICE" == true ]]; then
  cmd_service
fi

if [[ "$DO_RUN" == true ]]; then
  cmd_run
fi
