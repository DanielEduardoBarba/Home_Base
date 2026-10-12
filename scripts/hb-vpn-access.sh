#!/usr/bin/env bash
# Make Home Base and configured project ports reachable from the phone VPN.
#
# Strict rp_filter drops packets that arrive on wg* destined for this host's
# LAN address (e.g. 192.168.0.201) while still allowing the router. UFW is
# often enabled on laptops — allow the same ports from private nets and wg*.
#
#   sudo ./scripts/hb-vpn-access.sh          # apply + start homebased
#   sudo ./scripts/hb-vpn-access.sh --apply  # sysctl + firewall only (ExecStartPre)
#
# Idempotent: UFW rules use comments (hb-vpn-*) and are skipped when present.
# packaging/homebased.service already has ExecStartPre — do not add a drop-in
# that runs this script a second time (slow UFW churn on every restart).
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
for conf in /proc/sys/net/ipv4/conf/wg*/rp_filter; do
  [[ -e "$conf" ]] || continue
  sysctl -w "net.ipv4.conf.$(basename "$(dirname "$conf")").rp_filter=2" >/dev/null
done
cat >/etc/sysctl.d/99-homebase-vpn.conf <<'EOF'
# Home Base: loose reverse-path checks. Strict mode drops WireGuard packets
# addressed to this machine's Wi‑Fi IP while forwarded LAN hosts still answer.
net.ipv4.conf.all.rp_filter=2
net.ipv4.conf.default.rp_filter=2
EOF

hb_port="$(
  python3 - <<'PY'
import os
from pathlib import Path
def port_from(path):
    if not path.is_file():
        return None
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith("HOMEBASE_PORT="):
            raw = line.split("=", 1)[1].strip().strip('"').strip("'")
            try:
                n = int(raw)
            except ValueError:
                return None
            if 1 <= n <= 65535:
                return n
    return None
for p in (
    Path("/var/lib/homebased/.env"),
    Path(os.environ.get("ROOT", "")) / ".env",
):
    n = port_from(p)
    if n is not None:
        print(n)
        raise SystemExit(0)
print(8080)
PY
)"

ports="$(
  ROOT="$ROOT" HB_PORT="$hb_port" python3 - <<'PY'
import json
import os
from pathlib import Path
ports = {int(os.environ.get("HB_PORT") or 8080)}
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

wg_ifaces=()
for conf in /proc/sys/net/ipv4/conf/wg*/rp_filter; do
  [[ -e "$conf" ]] || continue
  wg_ifaces+=("$(basename "$(dirname "$conf")")")
done
if [[ ${#wg_ifaces[@]} -eq 0 ]]; then
  # Interface may come up after homebased; still seed rules for the usual name.
  wg_ifaces=(wg0)
fi

ufw_has_comment() {
  local comment="$1"
  grep -qF "comment=${comment}" /etc/ufw/user.rules 2>/dev/null \
    || grep -qF "# ${comment}" /etc/ufw/user.rules 2>/dev/null
}

ufw_allow_once() {
  local comment="$1"
  shift
  if ufw_has_comment "$comment"; then
    return 0
  fi
  ufw "$@" comment "$comment" >/dev/null || true
}

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  echo "==> UFW allow project ports from VPN/LAN (${ports})"
  for port in $ports; do
    for iface in "${wg_ifaces[@]}"; do
      ufw_allow_once "hb-vpn-${port}-${iface}" allow in on "$iface" to any port "$port" proto tcp
    done
    ufw_allow_once "hb-vpn-${port}-10" allow from 10.0.0.0/8 to any port "$port" proto tcp
    ufw_allow_once "hb-vpn-${port}-192" allow from 192.168.0.0/16 to any port "$port" proto tcp
    ufw_allow_once "hb-vpn-${port}-172" allow from 172.16.0.0/12 to any port "$port" proto tcp
  done
else
  echo "==> UFW inactive — skip firewall rules"
fi

# Unit file already runs ExecStartPre; remove legacy drop-in that doubled apply (~8s).
if [[ -f /etc/systemd/system/homebased.service.d/vpn-access.conf ]]; then
  if grep -q 'hb-vpn-access.sh --apply' /etc/systemd/system/homebased.service.d/vpn-access.conf 2>/dev/null; then
    echo "==> Removing duplicate ExecStartPre drop-in (vpn-access.conf)"
    rm -f /etc/systemd/system/homebased.service.d/vpn-access.conf
    systemctl daemon-reload || true
  fi
fi

if [[ "$APPLY_ONLY" == "1" ]]; then
  exit 0
fi

install -d /usr/share/homebased
install -m 0755 "$ROOT/scripts/hb-vpn-access.sh" /usr/share/homebased/hb-vpn-access.sh
systemctl daemon-reload
echo "==> Starting homebased.service"
systemctl reset-failed homebased.service 2>/dev/null || true
systemctl start homebased.service
systemctl --no-pager --full status homebased.service || true

echo "==> Probes (prefer WireGuard IP from phone VPN)"
probe_ips=(127.0.0.1)
while read -r iface ip; do
  [[ -n "$ip" ]] || continue
  probe_ips+=("$ip")
done < <(ip -o -4 addr show 2>/dev/null | awk '
  $2 ~ /^(wg|tun)/ || $2 ~ /^wlp/ || $2 ~ /^en/ || $2 ~ /^eth/ {
    split($4, a, "/"); print $2, a[1]
  }')
# Dedupe while preserving order
declare -A seen=()
for ip in "${probe_ips[@]}"; do
  [[ -n "${seen[$ip]:-}" ]] && continue
  seen[$ip]=1
  url="http://${ip}:${hb_port}/api/health"
  if curl -fsS --max-time 3 "$url" >/dev/null; then
    echo "  ok $url"
  else
    echo "  FAIL $url" >&2
  fi
done
echo "==> From a VPN client open: http://<wg-host-ip>:${hb_port}/ (not the Wi‑Fi 192.168.x address unless routed)"
