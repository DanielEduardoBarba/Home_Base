from __future__ import annotations

import socket
import threading
import time
import uuid
from typing import Any, Optional

from fastapi import HTTPException, Request

from .auth import JWT_TTL_SEC, assert_not_locked, issue_jwt, password_is_set, record_success

SHARE_TTL_SEC = 20
_lock = threading.Lock()
# Ephemeral in-memory only — never written to disk; never contains the password
_session: Optional[dict[str, Any]] = None


def mdns_hostname() -> str:
    """Best-effort Avahi/mDNS name: prefer avahi-daemon.conf host-name, else system hostname."""
    for conf in (
        "/etc/avahi/avahi-daemon.conf",
        "/usr/local/etc/avahi/avahi-daemon.conf",
    ):
        try:
            with open(conf, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    if key.strip().lower() == "host-name" and val.strip():
                        short = val.strip().split(".")[0]
                        return f"{short}.local"
        except OSError:
            continue

    try:
        host = socket.gethostname().strip() or "localhost"
    except Exception:
        host = "localhost"
    short = host.split(".")[0].strip() or "localhost"
    if short.lower().endswith(".local"):
        return short.lower()
    return f"{short}.local"


def is_localhost_browser(request: Request) -> bool:
    """
    True only when the SPA itself is loaded from localhost/127.0.0.1.
    Vite proxies make request.client.host look like 127.0.0.1 for LAN clients too,
    so Origin / Referer / Host must be checked — never trust client IP alone.
    """
    origin = (request.headers.get("origin") or "").lower()
    referer = (request.headers.get("referer") or "").lower()
    host = (request.headers.get("host") or "").split(":")[0].lower()

    def _ok(url: str) -> bool:
        if not url:
            return False
        return (
            "://localhost" in url
            or "://127.0.0.1" in url
            or "://[::1]" in url
            or url.startswith("http://localhost")
            or url.startswith("https://localhost")
            or url.startswith("http://127.0.0.1")
            or url.startswith("https://127.0.0.1")
        )

    if _ok(origin) or _ok(referer):
        return True
    return host in {"localhost", "127.0.0.1", "[::1]", "::1"}


def require_localhost_browser(request: Request) -> None:
    if not is_localhost_browser(request):
        raise HTTPException(
            status_code=403,
            detail="This action is only available when using localhost",
        )


def _purge_if_stale(now: Optional[float] = None) -> None:
    global _session
    now = now if now is not None else time.time()
    if _session is None:
        return
    if _session.get("consumed") or now >= float(_session.get("expiresAt", 0)):
        _session = None


def status() -> dict[str, Any]:
    with _lock:
        _purge_if_stale()
        if _session is None:
            return {
                "active": False,
                "consumed": False,
                "expiresIn": 0,
                "shareId": None,
                "hostname": mdns_hostname(),
            }
        now = time.time()
        return {
            "active": True,
            "consumed": bool(_session.get("consumed")),
            "expiresIn": max(0, int(float(_session["expiresAt"]) - now)),
            "shareId": _session.get("id"),
            "hostname": mdns_hostname(),
        }


def reveal(*, port: int, protocol: str = "http") -> dict[str, Any]:
    """Create a 20s one-time share code. QR never contains the password or a long-lived secret."""
    global _session
    if not password_is_set():
        raise HTTPException(400, "Set a password on localhost before sharing")

    port = int(port) if port else 80
    if port < 1 or port > 65535:
        raise HTTPException(400, "Invalid port")
    proto = "https" if str(protocol).lower().startswith("https") else "http"
    host = mdns_hostname()
    share_id = uuid.uuid4().hex
    now = time.time()
    expires_at = now + SHARE_TTL_SEC

    # Only a short-lived redeem id — phone exchanges it for a 24h JWT
    login_url = f"{proto}://{host}:{port}/?hb_share={share_id}"

    with _lock:
        _session = {
            "id": share_id,
            "expiresAt": expires_at,
            "consumed": False,
            "createdAt": now,
        }

    return {
        "shareId": share_id,
        "loginUrl": login_url,
        "expiresIn": SHARE_TTL_SEC,
        "hostname": host,
        "port": port,
    }


def hide() -> dict[str, Any]:
    global _session
    with _lock:
        _session = None
    return {"ok": True, "active": False}


def redeem(share_id: str) -> dict[str, Any]:
    """
    One-time exchange: valid share id → 24h session JWT.
    Clears the share session immediately (success or after consume).
    """
    global _session
    assert_not_locked()
    sid = (share_id or "").strip()
    if not sid:
        raise HTTPException(400, "Missing share id")
    if not password_is_set():
        raise HTTPException(503, "Password not configured")

    with _lock:
        _purge_if_stale()
        if _session is None or _session.get("id") != sid:
            raise HTTPException(401, "Share link expired or already used")
        _session = None

    record_success()
    issued = issue_jwt(kind="session", ttl=JWT_TTL_SEC)
    return {**issued, "shareConsumed": True}


# Back-compat name used by older login paths
def consume(share_id: str) -> bool:
    try:
        redeem(share_id)
        return True
    except HTTPException:
        return False
