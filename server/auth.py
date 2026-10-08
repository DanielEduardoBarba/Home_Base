from __future__ import annotations

import json
import secrets
import time
from typing import Optional

from fastapi import Header, HTTPException, Query, Request, WebSocket, status

from .config import LOCKOUT_PATH, RUNTIME_DIR, get_settings
from .logging_util import append_daily
from .notifications import push as notify

# After 5 failures: 10s, 30s, 1m, 3m, 5m, 10m, 30m, 1h, 1d
LOCKOUT_SCHEDULE = [10, 30, 60, 180, 300, 600, 1800, 3600, 86400]
FAIL_THRESHOLD = 5


def _expected() -> str:
    return get_settings().token


def _load_lockout() -> dict:
    if not LOCKOUT_PATH.is_file():
        return {"failCount": 0, "lockedUntil": 0.0}
    try:
        return json.loads(LOCKOUT_PATH.read_text())
    except Exception:
        return {"failCount": 0, "lockedUntil": 0.0}


def _save_lockout(data: dict) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    LOCKOUT_PATH.write_text(json.dumps(data, indent=2))


def lockout_status() -> dict:
    data = _load_lockout()
    now = time.time()
    remaining = max(0, int(data.get("lockedUntil", 0) - now))
    return {
        "failCount": int(data.get("failCount", 0)),
        "locked": remaining > 0,
        "retryAfter": remaining,
        "threshold": FAIL_THRESHOLD,
    }


def _client_ip(request: Optional[Request] = None, websocket: Optional[WebSocket] = None) -> str:
    if request is not None:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        if request.client:
            return request.client.host
    if websocket is not None:
        if websocket.client:
            return websocket.client.host
    return "unknown"


def record_success() -> None:
    _save_lockout({"failCount": 0, "lockedUntil": 0.0})


def record_failure(ip: str = "unknown", reason: str = "invalid_token") -> dict:
    data = _load_lockout()
    fail_count = int(data.get("failCount", 0)) + 1
    locked_until = float(data.get("lockedUntil", 0))
    now = time.time()

    if fail_count >= FAIL_THRESHOLD:
        idx = min(fail_count - FAIL_THRESHOLD, len(LOCKOUT_SCHEDULE) - 1)
        delay = LOCKOUT_SCHEDULE[idx]
        locked_until = now + delay
    else:
        delay = 0

    data = {"failCount": fail_count, "lockedUntil": locked_until}
    _save_lockout(data)

    append_daily(
        "auth_failure",
        ip=ip,
        reason=reason,
        failCount=fail_count,
        lockoutSeconds=delay,
    )
    if fail_count >= FAIL_THRESHOLD:
        notify(
            "Auth lockout",
            f"Failed login from {ip}. Wait {delay}s (failure #{fail_count}).",
            level="warn",
            category="security",
            meta={"ip": ip, "failCount": fail_count, "delay": delay},
        )

    return {
        "failCount": fail_count,
        "locked": delay > 0 or locked_until > now,
        "retryAfter": max(0, int(locked_until - now)),
    }


def assert_not_locked() -> None:
    data = _load_lockout()
    now = time.time()
    remaining = max(0, int(data.get("lockedUntil", 0) - now))
    if remaining > 0:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "message": "Too many failed attempts",
                "retryAfter": remaining,
                "failCount": data.get("failCount", 0),
            },
            headers={"Retry-After": str(remaining)},
        )


def verify_token(token: Optional[str], *, ip: str = "unknown") -> None:
    assert_not_locked()
    expected = _expected()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="HOMEBASE_TOKEN is not configured",
        )
    try:
        ok = bool(token) and secrets.compare_digest(token, expected)
    except (TypeError, ValueError):
        ok = False
    if not ok:
        info = record_failure(ip=ip)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "Invalid or missing token",
                "retryAfter": info.get("retryAfter", 0),
                "failCount": info.get("failCount", 0),
            },
        )
    record_success()


def bearer_from_header(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split(" ", 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return None


async def require_auth(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    token: Optional[str] = Query(default=None),
) -> None:
    verify_token(
        bearer_from_header(authorization) or token,
        ip=_client_ip(request=request),
    )


async def ws_authenticate(websocket: WebSocket) -> bool:
    token = websocket.query_params.get("token")
    if not token:
        auth = websocket.headers.get("authorization")
        token = bearer_from_header(auth)
    ip = _client_ip(websocket=websocket)
    try:
        assert_not_locked()
    except HTTPException as e:
        await websocket.close(code=4429, reason=str(e.detail)[:120])
        return False
    expected = _expected()
    if not expected:
        await websocket.close(code=4403, reason="HOMEBASE_TOKEN not configured")
        return False
    if not token or not secrets.compare_digest(token, expected):
        record_failure(ip=ip)
        await websocket.close(code=4401, reason="Unauthorized")
        return False
    record_success()
    return True
