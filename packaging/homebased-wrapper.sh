#!/usr/bin/env bash
# /usr/bin/homebased — probe the installed binary, fall back to .bak on failure.
set -euo pipefail

SHARE="${HOMEBASE_SHARE:-/usr/share/homebased}"
BIN="$SHARE/homebased"
BAK="$SHARE/homebased.bak"
MARKER="$SHARE/.running-backup"

run_probe() {
  local target="$1"
  [[ -x "$target" ]] || return 1
  # Short import/smoke test — must exit 0 quickly without binding ports.
  HOMEBASE_SELF_TEST=1 "$target" >/dev/null 2>&1
}

if [[ ! -x "$BIN" ]]; then
  echo "homebased: missing $BIN" >&2
  exit 127
fi

if run_probe "$BIN"; then
  rm -f "$MARKER" 2>/dev/null || true
  unset HOMEBASE_RUNNING_BACKUP || true
  exec "$BIN" "$@"
fi

echo "homebased: primary binary failed self-test — trying backup" >&2
if [[ -x "$BAK" ]] && run_probe "$BAK"; then
  echo "1" >"$MARKER" 2>/dev/null || true
  export HOMEBASE_RUNNING_BACKUP=1
  exec "$BAK" "$@"
fi

echo "homebased: primary and backup both failed self-test" >&2
exit 1
