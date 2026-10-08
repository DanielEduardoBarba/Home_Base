from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any, Optional

import jwt
from fastapi import Header, HTTPException, Query, Request, WebSocket, status

from .config import LOCKOUT_PATH, RUNTIME_DIR
from .logging_util import append_daily
from .notifications import push as notify

# After 5 failures: 10s … 1 day
LOCKOUT_SCHEDULE = [10, 30, 60, 180, 300, 600, 1800, 3600, 86400]
FAIL_THRESHOLD = 5

JWT_TTL_SEC = 24 * 60 * 60
JWT_ALG = "HS256"
AUTH_PATH = RUNTIME_DIR / "auth.json"
JWT_SECRET_PATH = RUNTIME_DIR / "jwt_secret"

# scrypt params (interactive login)
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 64


def _client_ip(request: Optional[Request] = None, websocket: Optional[WebSocket] = None) -> str:
    if request is not None:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        if request.client:
            return request.client.host
    if websocket is not None and websocket.client:
        return websocket.client.host
    return "unknown"


def _chmod_private(path: Path) -> None:
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def jwt_secret() -> bytes:
    """Persistent HMAC key for session JWTs (created once, mode 0600)."""
    env = os.environ.get("HOMEBASE_JWT_SECRET", "").strip()
    if env:
        return env.encode("utf-8")
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    if JWT_SECRET_PATH.is_file():
        raw = JWT_SECRET_PATH.read_bytes().strip()
        if len(raw) >= 32:
            return raw
    secret = secrets.token_bytes(48)
    JWT_SECRET_PATH.write_bytes(secret)
    _chmod_private(JWT_SECRET_PATH)
    return secret


def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii")


def _b64d(data: str) -> bytes:
    return base64.urlsafe_b64decode(data.encode("ascii"))


def _hash_password(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_DKLEN,
    )


def _load_auth() -> dict[str, Any]:
    if not AUTH_PATH.is_file():
        return {}
    try:
        return json.loads(AUTH_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_auth(data: dict[str, Any]) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    tmp = AUTH_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    _chmod_private(tmp)
    tmp.replace(AUTH_PATH)
    _chmod_private(AUTH_PATH)


def password_is_set() -> bool:
    data = _load_auth()
    return bool(data.get("passwordHash") and data.get("salt"))


def is_initialized() -> bool:
    """True once a password has been bootstrapped; blocks login-route setup forever."""
    data = _load_auth()
    if data.get("initialized"):
        return True
    # Migrate installs that already have a hash but no flag yet
    if data.get("passwordHash") and data.get("salt"):
        data["initialized"] = True
        _save_auth(data)
        return True
    return False


def can_bootstrap_password() -> bool:
    """Login-page create-password is allowed only before first init and with no stored hash."""
    return not is_initialized() and not password_is_set()


def validate_password_strength(password: str) -> str:
    pw = password or ""
    errors: list[str] = []
    if len(pw) < 10:
        errors.append("at least 10 characters")
    if not re.search(r"[a-z]", pw):
        errors.append("a lowercase letter")
    if not re.search(r"[A-Z]", pw):
        errors.append("an uppercase letter")
    if not re.search(r"[0-9]", pw):
        errors.append("a digit")
    if not re.search(r"[^A-Za-z0-9]", pw):
        errors.append("a special character")
    if errors:
        raise HTTPException(
            400,
            "Password must include " + ", ".join(errors),
        )
    return pw


def auth_epoch() -> int:
    """Monotonic counter bumped whenever the password hash is rewritten."""
    try:
        return int(_load_auth().get("authEpoch", 0) or 0)
    except (TypeError, ValueError):
        return 0


def _write_password_hash(password: str, *, initialized: bool) -> None:
    pw = validate_password_strength(password)
    salt = secrets.token_bytes(16)
    digest = _hash_password(pw, salt)
    prev = _load_auth()
    try:
        prev_epoch = int(prev.get("authEpoch", 0) or 0)
    except (TypeError, ValueError):
        prev_epoch = 0
    _save_auth(
        {
            **{k: v for k, v in prev.items() if k not in {"salt", "passwordHash"}},
            "algo": "scrypt",
            "n": _SCRYPT_N,
            "r": _SCRYPT_R,
            "p": _SCRYPT_P,
            "salt": _b64e(salt),
            "passwordHash": _b64e(digest),
            "initialized": bool(initialized),
            "authEpoch": prev_epoch + 1,
            "updatedAt": int(time.time()),
        }
    )


def bootstrap_password(password: str) -> None:
    """First-time setup only (login route). Sets initialized flag permanently."""
    if not can_bootstrap_password():
        raise HTTPException(
            403,
            "Password already initialized — use Share → Change password on localhost",
        )
    _write_password_hash(password, initialized=True)


def change_password(new_password: str, current_password: str) -> None:
    """Change an existing password (Share tab). Requires current password."""
    if not password_is_set() or not is_initialized():
        raise HTTPException(400, "No password to change — complete first-time setup")
    if not current_password or not verify_password(current_password):
        raise HTTPException(401, "Current password is incorrect")
    _write_password_hash(new_password, initialized=True)


def set_password(password: str) -> None:
    """Internal/test helper: write hash and mark initialized."""
    _write_password_hash(password, initialized=True)


def verify_password(password: str) -> bool:
    data = _load_auth()
    if not data.get("passwordHash") or not data.get("salt"):
        return False
    try:
        salt = _b64d(str(data["salt"]))
        expected = _b64d(str(data["passwordHash"]))
        got = _hash_password(password, salt)
        return secrets.compare_digest(got, expected)
    except Exception:
        return False


def issue_jwt(*, subject: str = "homebase", kind: str = "session", ttl: int = JWT_TTL_SEC) -> dict[str, Any]:
    now = int(time.time())
    exp = now + max(30, int(ttl))
    payload = {
        "sub": subject,
        "iat": now,
        "exp": exp,
        "kind": kind,
        "jti": secrets.token_hex(8),
        "ae": auth_epoch(),
    }
    token = jwt.encode(payload, jwt_secret(), algorithm=JWT_ALG)
    if isinstance(token, bytes):
        token = token.decode("ascii")
    return {"token": token, "expiresAt": exp, "expiresIn": exp - now, "kind": kind}


def decode_jwt(token: str) -> dict[str, Any]:
    return jwt.decode(
        token,
        jwt_secret(),
        algorithms=[JWT_ALG],
        options={"require": ["exp", "iat", "sub"]},
    )


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


def record_success() -> None:
    _save_lockout({"failCount": 0, "lockedUntil": 0.0})


def record_failure(ip: str = "unknown", reason: str = "invalid_password") -> dict:
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


def login_with_password(password: str, *, ip: str = "unknown") -> dict[str, Any]:
    assert_not_locked()
    if not password_is_set():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Password not set — open Home Base on localhost to create one",
        )
    if not verify_password(password):
        info = record_failure(ip=ip, reason="invalid_password")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "Invalid password",
                "retryAfter": info.get("retryAfter", 0),
                "failCount": info.get("failCount", 0),
            },
        )
    record_success()
    return issue_jwt(kind="session", ttl=JWT_TTL_SEC)


def verify_access_token(token: Optional[str], *, ip: str = "unknown") -> dict[str, Any]:
    """Validate a Bearer/session JWT. Does not count toward password lockout on expiry."""
    if not password_is_set():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Password not set — open Home Base on localhost to create one",
        )
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"message": "Missing session token", "code": "missing_token"},
        )
    try:
        claims = decode_jwt(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"message": "Session expired — sign in again", "code": "expired"},
        ) from None
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"message": "Invalid session token", "code": "invalid_token"},
        ) from None
    if claims.get("kind") not in {"session", "share"}:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"message": "Invalid session token", "code": "invalid_kind"},
        )
    # Share JWTs are only for the brief redeem window if we ever embed them;
    # API access requires a session token.
    if claims.get("kind") == "share":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"message": "Share token cannot access the API", "code": "share_token"},
        )
    try:
        token_epoch = int(claims.get("ae", 0) or 0)
    except (TypeError, ValueError):
        token_epoch = 0
    if token_epoch != auth_epoch():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "Session invalidated — sign in again",
                "code": "stale_session",
            },
        )
    return claims


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
) -> dict[str, Any]:
    return verify_access_token(
        bearer_from_header(authorization) or token,
        ip=_client_ip(request=request),
    )


async def ws_authenticate(websocket: WebSocket) -> bool:
    """Validate WS JWT before accept. On failure close with 44xx + reason `code:message`."""
    token = websocket.query_params.get("token")
    if not token:
        auth = websocket.headers.get("authorization")
        token = bearer_from_header(auth)
    try:
        verify_access_token(token, ip=_client_ip(websocket=websocket))
        return True
    except HTTPException as e:
        close_code = 4401
        if e.status_code == 429:
            close_code = 4429
        elif e.status_code == 503:
            close_code = 4403
        detail = e.detail
        if isinstance(detail, dict):
            err_code = str(detail.get("code") or "unauthorized")
            message = str(detail.get("message") or "Unauthorized")
        else:
            err_code = "unauthorized"
            message = str(detail or "Unauthorized")
        # Prefix with machine-readable code so the SPA can stop reconnecting.
        reason = f"{err_code}:{message}"[:120]
        try:
            await websocket.close(code=close_code, reason=reason)
        except Exception:
            pass
        return False


def auth_public_status() -> dict[str, Any]:
    boot = can_bootstrap_password()
    set_ = password_is_set()
    return {
        "passwordSet": set_ or is_initialized(),
        "initialized": is_initialized(),
        "canBootstrap": boot,
        "jwtTtlSec": JWT_TTL_SEC,
        "lockout": lockout_status(),
        # Legacy field for older clients during transition
        "tokenConfigured": set_ or is_initialized(),
    }


# Ensure signing key exists at import / first use
jwt_secret()
