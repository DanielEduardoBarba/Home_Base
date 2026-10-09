#!/usr/bin/env bash
# Run any command with a SINGLE sudo password prompt (timestamp kept alive).
# Prefer this over pkexec or many scattered sudo/pkexec calls.
#
# Examples:
#   ./scripts/hb-sudo-once.sh ./build.sh --service
#   ./scripts/hb-sudo-once.sh ./build.sh --deploy
#   ./scripts/hb-sudo-once.sh systemctl restart homebased
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$#" -lt 1 ]]; then
  echo "Usage: $0 <command> [args...]" >&2
  exit 2
fi

if [[ "$(id -u)" -eq 0 ]]; then
  exec "$@"
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "Error: sudo is required" >&2
  exit 1
fi

if ! sudo -n true 2>/dev/null; then
  echo "==> One sudo password for this whole command..."
  sudo -v
fi

# Refresh credential cache while the child runs (Nuitka/deploy can take minutes).
(
  while true; do
    sleep 50
    sudo -n true 2>/dev/null || exit 0
  done
) &
keep_pid=$!
cleanup() { kill "$keep_pid" 2>/dev/null || true; }
trap cleanup EXIT

# If the command is already our build.sh, it will reuse sudo -n (no re-prompt).
# Otherwise run the whole command as root once.
case "${1:-}" in
  ./build.sh|build.sh|"$ROOT/build.sh")
    exec "$@"
    ;;
  *)
    exec sudo -- "$@"
    ;;
esac
