#!/usr/bin/env bash
# /usr/bin/homebase — probe the installed binary, fall back to .bak on failure.
# systemd unit: homebased.service → this wrapper → /usr/share/homebased/homebase
set -euo pipefail

SHARE="${HOMEBASE_SHARE:-/usr/share/homebased}"
BIN="$SHARE/homebase"
BAK="$SHARE/homebase.bak"
# Older deploys used homebased as the binary filename
LEGACY_BIN="$SHARE/homebased"
LEGACY_BAK="$SHARE/homebased.bak"
MARKER="$SHARE/.running-backup"

if [[ ! -x "$BIN" && -x "$LEGACY_BIN" ]]; then
  BIN="$LEGACY_BIN"
fi
if [[ ! -x "$BAK" && -x "$LEGACY_BAK" ]]; then
  BAK="$LEGACY_BAK"
fi

run_probe() {
  local target="$1"
  [[ -x "$target" ]] || return 1
  # Probe never writes into /var/lib/homebased or /usr/share (Nuitka unpack + jwt).
  local tmp out rc
  tmp="$(mktemp -d /tmp/homebased-probe.XXXXXX)"
  out="$tmp/probe.out"
  # One retry: SIGKILL of a prior onefile run can leave /tmp in a bad state briefly.
  for _try in 1 2; do
    TMPDIR="$tmp" HOMEBASE_SELF_TEST=1 HOMEBASE_HOME="$tmp" HOMEBASE_RUNTIME="$tmp/.runtime" \
      "$target" >"$out" 2>&1
    rc=$?
    [[ "$rc" -eq 0 ]] && break
    sleep 0.15
  done
  if [[ "$rc" -ne 0 && -s "$out" ]]; then
    echo "homebase: self-test output from $target:" >&2
    sed -n '1,40p' "$out" >&2 || true
  fi
  rm -rf "$tmp" 2>/dev/null || true
  return "$rc"
}

if [[ ! -x "$BIN" ]]; then
  echo "homebase: missing $BIN" >&2
  exit 127
fi

if run_probe "$BIN"; then
  rm -f "$MARKER" 2>/dev/null || true
  unset HOMEBASE_RUNNING_BACKUP || true
  exec "$BIN" "$@"
fi

echo "homebase: primary binary failed self-test — trying backup" >&2
if [[ -x "$BAK" ]] && run_probe "$BAK"; then
  echo "1" >"$MARKER" 2>/dev/null || true
  export HOMEBASE_RUNNING_BACKUP=1
  exec "$BAK" "$@"
fi

echo "homebase: primary and backup both failed self-test" >&2
exit 1
