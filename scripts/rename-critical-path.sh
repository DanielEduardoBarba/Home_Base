#!/usr/bin/env bash
# server/ (Python) → server-py/server_py/ ; server-ts/ (Bun) → server/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> ROOT=$ROOT"

if [[ -d server ]] && [[ -f server/main.py ]] && [[ ! -f server/package.json ]]; then
  if [[ -d server-py ]]; then
    echo "Error: server-py already exists while Python still in server/" >&2
    exit 1
  fi
  echo "==> mv server → server-py"
  mv server server-py
fi

if [[ -d server-py ]] && [[ ! -d server-py/server_py ]] && [[ -f server-py/main.py ]]; then
  echo "==> nest Python package as server-py/server_py/ (import name server_py)"
  mkdir -p server-py/server_py
  shopt -s nullglob dotglob
  for item in server-py/*; do
    base="$(basename "$item")"
    [[ "$base" == "server_py" ]] && continue
    # Keep non-package cruft out; move python modules/packages only
    if [[ -f "$item" && "$base" == *.py ]] || [[ -d "$item" && -f "$item/__init__.py" ]]; then
      mv "$item" server-py/server_py/
    fi
  done
  shopt -u nullglob dotglob
  if [[ ! -f server-py/server_py/__init__.py ]]; then
    printf '%s\n' '"""Home Base control plane server (Python)."""' > server-py/server_py/__init__.py
  fi
fi

if [[ -d server-ts ]]; then
  if [[ -d server ]] && [[ -f server/package.json ]]; then
    echo "==> Bun server/ already present; removing leftover server-ts after confirming"
    # only remove if empty of unique content — prefer fail
    echo "Error: both server/ (Bun) and server-ts/ exist" >&2
    exit 1
  fi
  if [[ -d server ]]; then
    echo "Error: server/ exists and is not Bun package.json — abort" >&2
    exit 1
  fi
  echo "==> mv server-ts → server"
  mv server-ts server
fi

echo "==> Layout:"
ls -ld server server-py server-py/server_py 2>/dev/null || true
test -f server/package.json && echo "OK Bun server/package.json"
test -f server-py/server_py/main.py && echo "OK Python server-py/server_py/main.py"
echo "==> Done"
