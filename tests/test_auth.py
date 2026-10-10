from __future__ import annotations

import pytest
from fastapi import HTTPException


STRONG = "TestPass1!xx"


def test_bootstrap_login_and_verify(auth_runtime):
    from server_py import auth

    assert auth.can_bootstrap_password()
    auth.bootstrap_password(STRONG)
    assert auth.password_is_set()
    assert auth.auth_epoch() == 1

    issued = auth.login_with_password(STRONG, ip="127.0.0.1")
    assert issued["token"]
    claims = auth.verify_access_token(issued["token"])
    assert claims["kind"] == "session"
    assert claims["ae"] == 1


def test_invalid_password_rejected(auth_runtime):
    from server_py import auth

    auth.bootstrap_password(STRONG)
    with pytest.raises(HTTPException) as ei:
        auth.login_with_password("WrongPass1!", ip="127.0.0.1")
    assert ei.value.status_code == 401


def test_expired_and_invalid_token(auth_runtime):
    from server_py import auth

    auth.bootstrap_password(STRONG)
    with pytest.raises(HTTPException) as ei:
        auth.verify_access_token("not-a-jwt")
    assert ei.value.status_code == 401
    assert ei.value.detail["code"] == "invalid_token"

    with pytest.raises(HTTPException) as ei2:
        auth.verify_access_token("")
    assert ei2.value.detail["code"] == "missing_token"

    import time

    import jwt as pyjwt

    now = int(time.time())
    expired = pyjwt.encode(
        {
            "sub": "homebase",
            "iat": now - 120,
            "exp": now - 60,
            "kind": "session",
            "jti": "deadbeef",
            "ae": auth.auth_epoch(),
        },
        auth.jwt_secret(),
        algorithm=auth.JWT_ALG,
    )
    if isinstance(expired, bytes):
        expired = expired.decode("ascii")
    with pytest.raises(HTTPException) as ei3:
        auth.verify_access_token(expired)
    assert ei3.value.detail["code"] == "expired"


def test_password_change_bumps_epoch(auth_runtime):
    from server_py import auth

    auth.bootstrap_password(STRONG)
    first = auth.login_with_password(STRONG)
    assert auth.verify_access_token(first["token"])["ae"] == 1

    auth.change_password("NewPass2!xx", STRONG)
    assert auth.auth_epoch() == 2

    with pytest.raises(HTTPException) as ei:
        auth.verify_access_token(first["token"])
    assert ei.value.detail["code"] == "stale_session"

    second = auth.login_with_password("NewPass2!xx")
    assert auth.verify_access_token(second["token"])["ae"] == 2


def test_lockout_after_failures(auth_runtime):
    from server_py import auth

    auth.bootstrap_password(STRONG)
    for _ in range(auth.FAIL_THRESHOLD):
        try:
            auth.login_with_password("WrongPass1!", ip="10.0.0.1")
        except HTTPException:
            pass
    status = auth.lockout_status()
    assert status["failCount"] >= auth.FAIL_THRESHOLD
    assert status["locked"] is True
