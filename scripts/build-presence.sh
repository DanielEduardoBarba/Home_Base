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

# Prefer normal cargo target; also accept CARGO_TARGET_DIR (e.g. sandbox caches).
BIN=""
for candidate in \
  "$APP/src-tauri/target/release/homebase-presence" \
  "${CARGO_TARGET_DIR:-}/release/homebase-presence"; do
  if [[ -n "$candidate" && -f "$candidate" ]]; then
    BIN="$candidate"
    break
  fi
done
if [[ -z "$BIN" ]]; then
  # Last resort: newest homebase-presence under common target dirs
  BIN="$(find "$APP/src-tauri/target" "${CARGO_TARGET_DIR:-/tmp}" -type f -name homebase-presence 2>/dev/null | head -n1 || true)"
fi
if [[ -z "$BIN" || ! -f "$BIN" ]]; then
  echo "Error: missing homebase-presence release binary" >&2
  exit 1
fi

mkdir -p "$ROOT/dist" "$APP/src-tauri/target/release"
cp -f "$BIN" "$OUT"
cp -f "$BIN" "$APP/src-tauri/target/release/homebase-presence"
chmod 755 "$OUT" "$APP/src-tauri/target/release/homebase-presence"
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
