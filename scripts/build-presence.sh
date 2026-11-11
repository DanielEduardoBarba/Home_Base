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

# Prefer CARGO_TARGET_DIR (sandbox / custom) then the usual cargo target; newest wins.
pick_newest() {
  local best="" best_mtime=0 f m
  for f in "$@"; do
    [[ -n "$f" && -f "$f" ]] || continue
    m=$(stat -c %Y "$f" 2>/dev/null || echo 0)
    if (( m >= best_mtime )); then
      best="$f"
      best_mtime=$m
    fi
  done
  printf '%s' "$best"
}

BIN="$(pick_newest \
  "${CARGO_TARGET_DIR:+$CARGO_TARGET_DIR/release/homebase-presence}" \
  "$APP/src-tauri/target/release/homebase-presence")"
if [[ -z "$BIN" ]]; then
  BIN="$(find "$APP/src-tauri/target" ${CARGO_TARGET_DIR:+"$CARGO_TARGET_DIR"} /tmp/cursor-sandbox-cache -type f -name homebase-presence 2>/dev/null \
    | xargs -r ls -t 2>/dev/null | head -n1 || true)"
fi
if [[ -z "$BIN" || ! -f "$BIN" ]]; then
  echo "Error: missing homebase-presence release binary" >&2
  exit 1
fi

mkdir -p "$ROOT/dist" "$APP/src-tauri/target/release"
cp -f "$BIN" "$OUT"
DEST="$APP/src-tauri/target/release/homebase-presence"
if [[ "$(readlink -f "$BIN")" != "$(readlink -f "$DEST")" ]]; then
  cp -f "$BIN" "$DEST"
fi
chmod 755 "$OUT" "$DEST"
echo "    → $OUT (from $BIN)"

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
