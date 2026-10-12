#!/usr/bin/env bash
# Adaptive LAN device probe — stdout JSON: {up, detail, rssi?}
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
ID="${1:-}"
if [[ -z "$ID" ]]; then
  echo '{"up":0,"detail":"missing device id"}'
  exit 0
fi
DEV_JSON="$ROOT/devices.json"
if [[ ! -f "$DEV_JSON" ]]; then
  echo '{"up":0,"detail":"devices.json missing"}'
  exit 0
fi

mapfile -t META < <(python3 - "$DEV_JSON" "$ID" <<'PY'
import json, sys
path, did = sys.argv[1], sys.argv[2]
data = json.load(open(path))
dev = next((d for d in data.get("devices", []) if d.get("id") == did), None)
if not dev:
    print(""); print(""); print(""); print("")
    sys.exit(0)
print(dev.get("ip", ""))
print(dev.get("kind", "host"))
print(dev.get("label", did))
print(dev.get("id", did))
PY
)

IP="${META[0]:-}"
KIND="${META[1]:-host}"
LABEL="${META[2]:-$ID}"
if [[ -z "$IP" ]]; then
  echo '{"up":0,"detail":"unknown device"}'
  exit 0
fi

up=0
if ping -c1 -W1 "$IP" >/dev/null 2>&1; then
  up=1
elif ip neigh show "$IP" 2>/dev/null | grep -qiE 'REACHABLE|STALE|DELAY'; then
  up=1
fi

detail="$LABEL"
mdns=""
if command -v avahi-resolve-address >/dev/null 2>&1; then
  mdns="$(timeout 1 avahi-resolve-address "$IP" 2>/dev/null | awk '{print $2}' | head -1 || true)"
fi
if [[ -n "$mdns" ]]; then
  detail="$mdns"
fi

rssi=""
if [[ "$KIND" == "myq" && "$up" -eq 1 ]]; then
  body="$(curl -fsS --max-time 3 "http://$IP/" 2>/dev/null || true)"
  if [[ -n "$body" ]]; then
    eval "$(python3 - "$body" <<'PY'
import json, sys, shlex
try:
    d = json.loads(sys.argv[1])
except Exception:
    print('rssi=""'); print('detail_extra=""'); raise SystemExit
rssi = d.get("RSSI") or d.get("rssi") or ""
inet = d.get("Internet Connected") or d.get("InternetConnected") or ""
powered = d.get("Powered Time") or ""
model = d.get("Model Number") or d.get("Brand") or "MyQ"
bits = [str(model)]
if inet: bits.append("net " + str(inet))
if rssi != "": bits.append("RSSI " + str(rssi))
if powered: bits.append(str(powered).split(",")[0])
print("rssi=" + shlex.quote(str(rssi)))
print("detail_extra=" + shlex.quote(" · ".join(bits)))
PY
)"
    if [[ -n "${detail_extra:-}" ]]; then
      detail="$detail_extra"
    fi
  fi
fi

if [[ "$up" -eq 0 ]]; then
  detail="$LABEL offline"
elif [[ "$KIND" != "myq" ]]; then
  detail="$LABEL online${mdns:+ · $mdns}"
fi

python3 - "$up" "$detail" "$rssi" <<'PY'
import json, sys
up = int(sys.argv[1])
detail = sys.argv[2]
rssi = sys.argv[3]
out = {"up": up, "detail": detail}
if rssi not in ("", None):
    try:
        out["rssi"] = int(str(rssi).strip())
    except ValueError:
        try:
            out["rssi"] = float(str(rssi).strip())
        except ValueError:
            pass
print(json.dumps(out, separators=(",", ":")))
PY
