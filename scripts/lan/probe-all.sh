#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
python3 - "$ROOT/devices.json" <<'PY'
import json, sys, subprocess, os
root = os.path.dirname(sys.argv[1])
data = json.load(open(sys.argv[1]))
probe = os.path.join(root, "probe.sh")
results = []
for d in data.get("devices", []):
    try:
        out = subprocess.check_output([probe, d["id"]], text=True, timeout=8)
        results.append({"id": d["id"], **json.loads(out)})
    except Exception as e:
        results.append({"id": d["id"], "up": 0, "detail": str(e)[:80]})
print(json.dumps({"ok": True, "results": results}, indent=2))
PY
