#!/usr/bin/env bash
# Make Home Base and configured project ports reachable from the phone VPN.
#
# Strict rp_filter drops packets that arrive on wg0 destined for this host's
# LAN address (192.168.0.201) while still allowing the router (192.168.0.1).
# UFW is enabled on this laptop; allow the same ports from private nets and wg0.
#
#   sudo ./scripts/hb-vpn-access.sh          # apply + start homebased
#   sudo ./scripts/hb-vpn-access.sh --apply  # sysctl + firewall only (ExecStartPre)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPLY_ONLY=0
if [[ "${1:-}" == "--apply" ]]; then
  APPLY_ONLY=1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: run as root (sudo ./scripts/hb-vpn-access.sh)" >&2
  exit 1
fi

echo "==> Loose rp_filter so VPN clients can reach this host's LAN address"
sysctl -w net.ipv4.conf.all.rp_filter=2 >/dev/null
sysctl -w net.ipv4.conf.default.rp_filter=2 >/dev/null
if [[ -e /proc/sys/net/ipv4/conf/wg0/rp_filter ]]; then
  sysctl -w net.ipv4.conf.wg0.rp_filter=2 >/dev/null
fi
cat >/etc/sysctl.d/99-homebase-vpn.conf <<'EOF'
# Home Base: loose reverse-path checks. Strict mode drops WireGuard packets
# addressed to this machine's Wi-Fi IP while forwarded LAN hosts still answer.
net.ipv4.conf.all.rp_filter=2
net.ipv4.conf.default.rp_filter=2
EOF

ports="$(
  ROOT="$ROOT" python3 - <<'PY'
import json
import os
from pathlib import Path
ports = {8888}
candidates = [
    Path(os.environ.get("ROOT", "")) / "config" / "projects.json",
    Path("/var/lib/homebased/config/projects.json"),
]
cfg = next((p for p in candidates if p.is_file()), None)
if cfg is not None:
    data = json.loads(cfg.read_text())
    for proj in data.get("projects") or []:
        for item in proj.get("ports") or []:
            try:
                n = int(item.get("port") or 0)
            except (TypeError, ValueError):
                continue
            if 1 <= n <= 65535:
                ports.add(n)
print(" ".join(str(n) for n in sorted(ports)))
PY
)"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  echo "==> UFW allow project ports from VPN/LAN (${ports})"
  for port in $ports; do
    ufw allow in on wg0 to any port "$port" proto tcp >/dev/null || true
    ufw allow from 10.0.0.0/8 to any port "$port" proto tcp >/dev/null || true
    ufw allow from 192.168.0.0/16 to any port "$port" proto tcp >/dev/null || true
    ufw allow from 172.16.0.0/12 to any port "$port" proto tcp >/dev/null || true
  done
else
  echo "==> UFW inactive — skip firewall rules"
fi

if [[ "$APPLY_ONLY" == "1" ]]; then
  exit 0
fi

install -d /usr/share/homebased
install -m 0755 "$ROOT/scripts/hb-vpn-access.sh" /usr/share/homebased/hb-vpn-access.sh
mkdir -p /etc/systemd/system/homebased.service.d
cat >/etc/systemd/system/homebased.service.d/vpn-access.conf <<'EOF'
[Service]
ExecStartPre=/usr/share/homebased/hb-vpn-access.sh --apply
EOF
systemctl daemon-reload
echo "==> Starting homebased.service"
systemctl reset-failed homebased.service 2>/dev/null || true
systemctl start homebased.service
systemctl --no-pager --full status homebased.service || true

echo "==> Probes"
for url in \
  http://127.0.0.1:8888/api/health \
  http://192.168.0.201:8888/api/health \
  http://10.6.0.1:8888/api/health
do
  if curl -fsS --max-time 3 "$url"; then
    echo "  ok $url"
  else
    echo "  FAIL $url" >&2
  fi
done
