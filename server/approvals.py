"""Tool/shell approval gate for Cursor SDK hooks → Home Base chat UI.

Hook scripts POST here (localhost + shared secret). The request blocks until
a connected chat client Allow/Deny's, or until timeout / auto-run policy.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from .config import RUNTIME_DIR

log = logging.getLogger("homebase.approvals")

SECRET_PATH = RUNTIME_DIR / "hook_secret"
Listener = Callable[[dict[str, Any]], Awaitable[None] | None]

# Global policy for new approvals: ask (IDE-like) or auto-allow.
_policy = "ask"  # ask | auto
_pending: dict[str, "ApprovalRequest"] = {}
_lock = asyncio.Lock()
_listeners: list[Listener] = []


@dataclass
class ApprovalRequest:
    id: str
    kind: str
    tool: str
    detail: str
    command: str = ""
    cwd: str = ""
    project_hint: str = ""
    chat_id: str = ""
    agent_id: str = ""
    created_at: float = field(default_factory=time.time)
    _event: asyncio.Event = field(default_factory=asyncio.Event)
    decision: Optional[str] = None  # allow | deny
    message: str = ""


def ensure_hook_secret() -> str:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    if SECRET_PATH.is_file():
        val = SECRET_PATH.read_text().strip()
        if val:
            return val
    val = secrets.token_hex(24)
    SECRET_PATH.write_text(val)
    try:
        SECRET_PATH.chmod(0o600)
    except OSError:
        pass
    return val


def verify_secret(provided: str) -> bool:
    expected = ensure_hook_secret()
    return bool(provided) and secrets.compare_digest(provided, expected)


def set_policy(policy: str) -> str:
    global _policy
    p = (policy or "ask").strip().lower()
    if p not in {"ask", "auto"}:
        p = "ask"
    _policy = p
    return _policy


def get_policy() -> str:
    return _policy


def add_listener(fn: Listener) -> None:
    _listeners.append(fn)


def remove_listener(fn: Listener) -> None:
    try:
        _listeners.remove(fn)
    except ValueError:
        pass


async def _broadcast(payload: dict[str, Any]) -> None:
    for fn in list(_listeners):
        try:
            res = fn(payload)
            if asyncio.iscoroutine(res) or asyncio.isfuture(res):
                await res  # type: ignore[arg-type]
        except Exception as e:
            log.warning("approval listener failed: %s", e)


def list_pending() -> list[dict[str, Any]]:
    return [
        {
            "id": r.id,
            "kind": r.kind,
            "tool": r.tool,
            "detail": r.detail,
            "command": r.command,
            "cwd": r.cwd,
            "chatId": r.chat_id,
            "agentId": r.agent_id,
            "createdAt": r.created_at,
        }
        for r in _pending.values()
        if r.decision is None
    ]


async def decide(approval_id: str, decision: str, message: str = "") -> bool:
    d = (decision or "").strip().lower()
    if d not in {"allow", "deny"}:
        return False
    async with _lock:
        req = _pending.get(approval_id)
        if not req or req.decision is not None:
            return False
        req.decision = d
        req.message = message
        req._event.set()
    await _broadcast(
        {
            "type": "approval-resolved",
            "id": approval_id,
            "decision": d,
            "chatId": req.chat_id,
        }
    )
    return True


async def request_approval(
    *,
    kind: str,
    tool: str,
    detail: str,
    command: str = "",
    cwd: str = "",
    project_hint: str = "",
    chat_id: str = "",
    agent_id: str = "",
    timeout: float = 560.0,
) -> dict[str, Any]:
    """Block until Allow/Deny (or auto / timeout → deny)."""
    if get_policy() == "auto":
        return {"permission": "allow", "user_message": "Auto-run tools enabled"}

    aid = secrets.token_hex(8)
    req = ApprovalRequest(
        id=aid,
        kind=kind or "tool",
        tool=tool or "tool",
        detail=(detail or "")[:2000],
        command=(command or "")[:4000],
        cwd=(cwd or "")[:1000],
        project_hint=project_hint or "",
        chat_id=chat_id or "",
        agent_id=agent_id or "",
    )
    async with _lock:
        _pending[aid] = req

    payload = {
        "type": "approval",
        "id": aid,
        "kind": req.kind,
        "tool": req.tool,
        "detail": req.detail,
        "command": req.command,
        "cwd": req.cwd,
        "chatId": req.chat_id,
        "agentId": req.agent_id,
        "createdAt": req.created_at,
    }
    await _broadcast(payload)
    trace_safe = f"approval pending {req.tool}: {(req.command or req.detail)[:120]}"
    try:
        from .trace_log import append as trace_append

        trace_append("info", trace_safe, source="approvals")
    except Exception:
        pass

    try:
        await asyncio.wait_for(req._event.wait(), timeout=max(5.0, timeout))
    except asyncio.TimeoutError:
        req.decision = "deny"
        req.message = "Timed out waiting for approval"
        await _broadcast(
            {
                "type": "approval-resolved",
                "id": aid,
                "decision": "deny",
                "chatId": req.chat_id,
                "reason": "timeout",
            }
        )

    async with _lock:
        _pending.pop(aid, None)

    decision = req.decision or "deny"
    return {
        "permission": decision,
        "user_message": req.message
        or ("Allowed" if decision == "allow" else "Denied"),
        "agent_message": (
            "User approved this action."
            if decision == "allow"
            else "User denied this action — do not retry without asking."
        ),
    }


def ensure_user_hooks(hook_bin: Path) -> Optional[Path]:
    """Install/merge ~/.cursor/hooks.json so local SDK agents hit our approver."""
    if not hook_bin.is_file():
        log.warning("approval hook binary missing: %s", hook_bin)
        return None
    resolved = hook_bin.resolve()
    # Nuitka onefile unpacks under /tmp/onefile_* — never persist that path.
    if "/tmp/onefile_" in str(resolved):
        stable = Path("/usr/share/homebased/hb-hook-approve")
        if stable.is_file():
            resolved = stable.resolve()
        else:
            log.warning("skipping ephemeral onefile hook path: %s", resolved)
            return None
    try:
        resolved.chmod(0o755)
    except OSError:
        pass

    cursor_dir = Path.home() / ".cursor"
    cursor_dir.mkdir(parents=True, exist_ok=True)
    hooks_path = cursor_dir / "hooks.json"
    entry = {
        "command": str(resolved),
        "timeout": 600,
        "failClosed": True,
    }
    data: dict[str, Any] = {"version": 1, "hooks": {}}
    if hooks_path.is_file():
        try:
            import json

            loaded = json.loads(hooks_path.read_text())
            if isinstance(loaded, dict):
                data = loaded
        except Exception:
            pass
    data.setdefault("version", 1)
    hooks = data.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        hooks = {}
        data["hooks"] = hooks

    def _upsert(event: str, matcher: Optional[str] = None) -> None:
        lst = hooks.get(event)
        if not isinstance(lst, list):
            lst = []
            hooks[event] = lst
        # Replace any prior Home Base hook entry
        keep = [
            h
            for h in lst
            if not (
                isinstance(h, dict)
                and "hb-hook-approve" in str(h.get("command") or "")
            )
        ]
        item = dict(entry)
        if matcher:
            item["matcher"] = matcher
        keep.append(item)
        hooks[event] = keep

    _upsert("beforeShellExecution")
    _upsert("preToolUse", matcher="Write|Delete|Edit|Shell|StrReplace|ApplyPatch|DeleteFile|WriteFile")

    import json

    hooks_path.write_text(json.dumps(data, indent=2) + "\n")
    ensure_hook_secret()
    log.info("installed Cursor approval hooks → %s", hooks_path)
    return hooks_path
