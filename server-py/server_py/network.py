"""Reachable host IPs for VPN / LAN clients (Expo Metro, public API URLs)."""

from __future__ import annotations

import ipaddress
import os
import socket
import subprocess
from typing import Optional


# VPN/tunnel faces — used only as fallback. Expo phones on Wi‑Fi need LAN 192.168.x.
_VPN_PREFIXES = ("wg", "tun", "tailscale", "zt", "nebula", "ipsec")
_SKIP_IFACE_PREFIXES = ("docker", "br-", "veth", "virbr", "lxc", "cni", "flannel")


def _is_usable_ipv4(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if addr.version != 4:
        return False
    if addr.is_loopback or addr.is_link_local or addr.is_multicast or addr.is_unspecified:
        return False
    return True


def list_ipv4_interfaces() -> list[tuple[str, str]]:
    """Return [(iface, ipv4), ...] for non-loopback addresses (best-effort)."""
    out: list[tuple[str, str]] = []
    try:
        import netifaces  # type: ignore
    except ImportError:
        netifaces = None  # type: ignore

    if netifaces is not None:
        for iface in netifaces.interfaces():
            if iface == "lo" or iface.startswith("lo"):
                continue
            for info in netifaces.ifaddresses(iface).get(netifaces.AF_INET, []):
                ip = str(info.get("addr") or "").strip()
                if _is_usable_ipv4(ip):
                    out.append((iface, ip))
        if out:
            return out
        # netifaces present but empty — fall through to `ip` / hostname

    # Fallback: hostname resolution + Linux `ip -o -4 addr`
    try:
        host = socket.gethostname()
        for info in socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM):
            ip = info[4][0]
            if _is_usable_ipv4(ip):
                out.append(("host", ip))
    except OSError:
        pass

    # Linux: parse `ip -o -4 addr show` without depending on netifaces
    try:
        proc = subprocess.run(
            ["ip", "-o", "-4", "addr", "show"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
        if proc.returncode == 0 and proc.stdout:
            parsed: list[tuple[str, str]] = []
            for line in proc.stdout.splitlines():
                parts = line.split()
                if len(parts) < 4:
                    continue
                iface = parts[1].split("@", 1)[0]
                if iface == "lo" or iface.startswith("lo"):
                    continue
                cidr = parts[3]
                ip = cidr.split("/", 1)[0]
                if _is_usable_ipv4(ip):
                    parsed.append((iface, ip))
            if parsed:
                return parsed
    except (OSError, subprocess.SubprocessError):
        pass

    return out


def _is_vpn_iface(iface: str) -> bool:
    name = iface.lower()
    return any(name == p or name.startswith(p) for p in _VPN_PREFIXES)


def _is_skip_iface(iface: str) -> bool:
    name = iface.lower()
    if name == "lo" or name.startswith("lo"):
        return True
    return any(name == p or name.startswith(p) for p in _SKIP_IFACE_PREFIXES)


def _lan_score(iface: str, ip: str) -> int:
    """Higher = better for Expo Go on the same Wi‑Fi as the Home Base laptop."""
    name = iface.lower()
    score = 0
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return -1
    if addr.packed[0:2] == bytes((192, 168)):
        score += 100
    elif addr.is_private:
        score += 40
    if name.startswith(("wl", "wlan", "en", "eth", "em")):
        score += 50
    return score


def advertise_host() -> Optional[str]:
    """
    IPv4 Expo Go / Metro / project APIs should advertise.

    Order: HOMEBASE_ADVERTISE_HOST override → native LAN (prefer 192.168.x on
    wifi/ethernet) → WireGuard/tunnel → any other usable IPv4.
    """
    override = (os.environ.get("HOMEBASE_ADVERTISE_HOST") or "").strip()
    if override and _is_usable_ipv4(override):
        return override
    if override and not override.startswith("["):
        # Allow hostnames (rare); still pass through if non-empty
        if override and override.lower() not in {"localhost", "0.0.0.0"}:
            return override

    addrs = [(i, ip) for i, ip in list_ipv4_interfaces() if not _is_skip_iface(i)]

    lan = [
        (iface, ip)
        for iface, ip in addrs
        if not _is_vpn_iface(iface)
        and _is_usable_ipv4(ip)
        and ipaddress.ip_address(ip).is_private
    ]
    lan.sort(key=lambda t: _lan_score(t[0], t[1]), reverse=True)
    if lan:
        return lan[0][1]

    for iface, ip in addrs:
        if _is_vpn_iface(iface):
            return ip

    for _iface, ip in addrs:
        try:
            if ipaddress.ip_address(ip).is_private:
                return ip
        except ValueError:
            continue

    if addrs:
        return addrs[0][1]
    return None


def lan_host() -> Optional[str]:
    """Best non-VPN private IPv4 (Wi‑Fi / Ethernet), or None."""
    addrs = [(i, ip) for i, ip in list_ipv4_interfaces() if not _is_skip_iface(i)]
    lan = [
        (iface, ip)
        for iface, ip in addrs
        if not _is_vpn_iface(iface)
        and _is_usable_ipv4(ip)
        and ipaddress.ip_address(ip).is_private
    ]
    lan.sort(key=lambda t: _lan_score(t[0], t[1]), reverse=True)
    return lan[0][1] if lan else None


def vpn_host() -> Optional[str]:
    """First WireGuard / VPN iface IPv4 (phone clients should use this for :8888)."""
    for iface, ip in list_ipv4_interfaces():
        if _is_vpn_iface(iface) and _is_usable_ipv4(ip):
            return ip
    return None


def access_hosts(port: int) -> dict:
    lan = lan_host()
    vpn = vpn_host()
    return {
        "lanHost": lan,
        "vpnHost": vpn,
        "advertiseHost": advertise_host(),
        "port": port,
        "urls": {
            "lan": f"http://{lan}:{port}/" if lan else None,
            "vpn": f"http://{vpn}:{port}/" if vpn else None,
        },
    }


def project_lan_env(project_ports: list[tuple[str, int]]) -> dict[str, str]:
    """
    Env injected into run/expo PTYs so Next/Expo/API clients use a VPN-reachable host.

    project_ports: [(id, port), ...] from the project config (api/web/expo).
    """
    env: dict[str, str] = {
        # Next.js listens on all interfaces when hostname is unset/0.0.0.0
        "HOSTNAME": "0.0.0.0",
    }
    host = advertise_host()
    if not host:
        return env

    env["HOMEBASE_ADVERTISE_HOST"] = host
    # Expo / Metro: QR + hostUri — native Wi‑Fi LAN preferred (not WireGuard)
    env["REACT_NATIVE_PACKAGER_HOSTNAME"] = host

    ports = {pid: port for pid, port in project_ports}
    api_port = ports.get("api")
    web_port = ports.get("web")

    if api_port:
        api_base = f"http://{host}:{api_port}/api/v1"
        env["EXPO_PUBLIC_API_URL"] = api_base
        env["NEXT_PUBLIC_API_URL"] = api_base

    if web_port:
        web_origin = f"http://{host}:{web_port}"
        env.setdefault("WEB_ORIGIN", web_origin)
        env.setdefault("NEXT_PUBLIC_SITE_URL", web_origin)

    return env
