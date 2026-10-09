"""Reachable host IPs for VPN / LAN clients (Expo Metro, public API URLs)."""

from __future__ import annotations

import ipaddress
import os
import socket
import subprocess
from typing import Optional


# Prefer tunnel/VPN faces so phones on WireGuard get a routable packager/API host.
_VPN_PREFIXES = ("wg", "tun", "tailscale", "zt", "nebula", "ipsec")


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
        return out

    # Fallback: hostname -I order (no iface names) + optional `ip` parse via UDP trick
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


def advertise_host() -> Optional[str]:
    """
    IPv4 that VPN/LAN clients should use for Metro + project APIs.

    Order: HOMEBASE_ADVERTISE_HOST override → WireGuard/tunnel iface →
    first private RFC1918 → any other usable IPv4.
    """
    override = (os.environ.get("HOMEBASE_ADVERTISE_HOST") or "").strip()
    if override and _is_usable_ipv4(override):
        return override
    if override and not override.startswith("["):
        # Allow hostnames (rare); still pass through if non-empty
        if override and override.lower() not in {"localhost", "0.0.0.0"}:
            return override

    addrs = list_ipv4_interfaces()
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
    # Expo / Metro: QR + hostUri must be the VPN/LAN IP, not Wi‑Fi-only guess
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
