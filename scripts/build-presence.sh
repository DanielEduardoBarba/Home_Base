#!/usr/bin/env bash
# Build the Tauri presence mini-app → dist/homebase-presence (+ optional system install)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/presence-app"
OUT="$ROOT/dist/homebase-presence"

cd "$APP"
if [[ ! -d node_modules ]]; then
  bun install
fi

echo "==> Building Home Base Presence (Tauri)"
bun run tauri:build

BIN="$APP/src-tauri/target/release/homebase-presence"
if [[ ! -f "$BIN" ]]; then
  echo "Error: missing $BIN" >&2
  exit 1
fi

mkdir -p "$ROOT/dist"
cp -f "$BIN" "$OUT"
chmod 755 "$OUT"
echo "    → $OUT"

if [[ "${1:-}" == "--install" ]]; then
  if [[ "$(id -u)" -eq 0 ]]; then
    install -m 755 "$OUT" /usr/share/homebased/homebase-presence
    echo "    installed /usr/share/homebased/homebase-presence"
  else
    mkdir -p "$HOME/.local/share/homebase"
    cp -f "$OUT" "$HOME/.local/share/homebase/homebase-presence"
    chmod 755 "$HOME/.local/share/homebase/homebase-presence"
    echo "    installed $HOME/.local/share/homebase/homebase-presence"
  fi
fi
