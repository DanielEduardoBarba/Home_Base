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
  # Probe never writes into /var/lib/homebased or /usr/share (Nuitka unpack + jwt).
  local tmp
  tmp="$(mktemp -d /tmp/homebased-probe.XXXXXX)"
  TMPDIR="$tmp" HOMEBASE_SELF_TEST=1 HOMEBASE_HOME="$tmp" HOMEBASE_RUNTIME="$tmp/.runtime" \
    "$target" >/dev/null 2>&1
  local rc=$?
  rm -rf "$tmp" 2>/dev/null || true
  return "$rc"
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
