"""Short-lived sudo password vault + askpass helper.

Agent shells and Home Base PTYs can need an interactive sudo password.
We never log the secret; TTL is short; askpass reads from a 0600 runtime file.
"""
from __future__ import annotations

import logging
import os
import re
import time
from pathlib import Path
from typing import Any

from .config import RUNTIME_DIR

log = logging.getLogger("homebase.sudo")

TTL_SEC = 300
_PASS_PATH = RUNTIME_DIR / "sudo_askpass.pass"
_META_PATH = RUNTIME_DIR / "sudo_askpass.meta"
_ASKPASS_PATH = RUNTIME_DIR / "sudo-askpass"
_SUDO_PROMPT_RE = re.compile(
    r"(?:\[sudo\]\s+password\s+for\b|"
    r"password\s+for\s+\S+\s*:|"
    r"^Password\s*:|"
    r"SUDO_ASKPASS|"
    r"sudo:\s+a\s+password\s+is\s+required)",
    re.IGNORECASE | re.MULTILINE,
)

_lock_note = "sudo vault"


def detect_sudo_prompt(text: str) -> bool:
    if not text or not text.strip():
        return False
    return bool(_SUDO_PROMPT_RE.search(text))


def _ensure_askpass_script() -> Path:
    """Install a tiny askpass binary that prints the vaulted password (or waits briefly)."""
    script = f"""#!/bin/sh
# Home Base SUDO_ASKPASS — do not commit; written by homebased.
PASS_FILE="{_PASS_PATH}"
META_FILE="{_META_PATH}"
TTL={TTL_SEC}
now=$(date +%s)
if [ -f "$META_FILE" ]; then
  exp=$(cat "$META_FILE" 2>/dev/null || echo 0)
  if [ -n "$exp" ] && [ "$now" -gt "$exp" ]; then
    rm -f "$PASS_FILE" "$META_FILE" 2>/dev/null || true
  fi
fi
# Wait up to 90s for the Chat UI to supply a password.
i=0
while [ "$i" -lt 90 ]; do
  if [ -f "$PASS_FILE" ] && [ -s "$PASS_FILE" ]; then
    cat "$PASS_FILE"
    exit 0
  fi
  # Signal that askpass is waiting (meta mtime; Chat polls via WS events).
  printf '%s\\n' "$((now + TTL))" > "$META_FILE.wait" 2>/dev/null || true
  sleep 1
  i=$((i + 1))
  now=$(date +%s)
done
echo "homebase: sudo password not provided in time" >&2
exit 1
"""
    try:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        if not _ASKPASS_PATH.is_file() or _ASKPASS_PATH.read_text() != script:
            _ASKPASS_PATH.write_text(script)
            _ASKPASS_PATH.chmod(0o700)
    except OSError as e:
        log.warning("askpass script write failed: %s", e)
    return _ASKPASS_PATH


def store_password(password: str, *, ttl_sec: int = TTL_SEC) -> dict[str, Any]:
    """Persist password for askpass / PTY injection. Never logged."""
    pw = (password or "").rstrip("\n")
    if not pw:
        raise ValueError("password required")
    _ensure_askpass_script()
    exp = int(time.time()) + max(30, min(int(ttl_sec), 3600))
    try:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        _PASS_PATH.write_text(pw + "\n")
        _PASS_PATH.chmod(0o600)
        _META_PATH.write_text(str(exp))
        _META_PATH.chmod(0o600)
        wait = RUNTIME_DIR / "sudo_askpass.meta.wait"
        try:
            wait.unlink()
        except FileNotFoundError:
            pass
    except OSError as e:
        log.warning("sudo vault write failed: %s", e)
        raise
    # So child processes of homebased (cursor bridge / PTYs) inherit askpass.
    path = str(_ASKPASS_PATH.resolve())
    os.environ["SUDO_ASKPASS"] = path
    os.environ["SUDO_ASKPASS_REQUIRE_PASSWORD"] = "1"
    log.info("sudo password vaulted ttl=%ss (secret not logged)", exp - int(time.time()))
    return {"ok": True, "expiresAt": exp, "ttlSec": exp - int(time.time())}


def clear_password() -> None:
    for p in (_PASS_PATH, _META_PATH, RUNTIME_DIR / "sudo_askpass.meta.wait"):
        try:
            p.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass
    log.info("sudo password vault cleared")


def status() -> dict[str, Any]:
    """Public status — never includes the password."""
    _ensure_askpass_script()
    now = int(time.time())
    exp = 0
    try:
        if _META_PATH.is_file():
            exp = int(_META_PATH.read_text().strip() or "0")
    except (OSError, ValueError):
        exp = 0
    has = False
    try:
        has = _PASS_PATH.is_file() and _PASS_PATH.stat().st_size > 0 and exp > now
    except OSError:
        has = False
    if not has and exp and exp <= now:
        clear_password()
        exp = 0
    waiting = False
    try:
        waiting = (RUNTIME_DIR / "sudo_askpass.meta.wait").is_file()
    except OSError:
        waiting = False
    return {
        "cached": has,
        "expiresAt": exp if has else 0,
        "ttlSec": max(0, exp - now) if has else 0,
        "askpassWaiting": waiting,
        "askpassPath": str(_ASKPASS_PATH),
    }


def askpass_env() -> dict[str, str]:
    """Env vars to merge into PTY / shell spawns."""
    _ensure_askpass_script()
    return {
        "SUDO_ASKPASS": str(_ASKPASS_PATH.resolve()),
        "SUDO_ASKPASS_REQUIRE_PASSWORD": "1",
    }


def ensure_process_env() -> None:
    """Install askpass into the homebased process env (inherited by children)."""
    env = askpass_env()
    os.environ.update(env)
