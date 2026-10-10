"""Mirror Cursor agent shell tool output into Home Base PTY sessions.

Agent shells run inside the cursor-sdk bridge (not our PTY). We spawn a
display PTY (`cat` sink) so the same command appears in the Shell tab;
shell-output-delta / completion text is written into that session.
"""
from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Mapping
from typing import Any, Optional

from .config import get_project
from .pty_manager import pty_manager

log = logging.getLogger("homebase.agent_shell")

# call_id → session_id
_mirrors: dict[str, str] = {}
_lock = asyncio.Lock()


def _as_dict(val: Any) -> dict[str, Any]:
    if isinstance(val, Mapping):
        return dict(val)
    return {}


def _tool_type(tool: Mapping[str, Any]) -> str:
    for key in ("type", "name", "toolName", "tool_name"):
        v = tool.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    # Nested Cursor shapes: { shell: { args: … } } / shellToolCall
    for key in tool:
        lk = str(key).lower()
        if "shell" in lk and isinstance(tool.get(key), Mapping):
            return "shell"
        if lk.endswith("toolcall") or lk.endswith("_tool_call"):
            inner = _as_dict(tool.get(key))
            t = inner.get("type") or inner.get("name")
            if isinstance(t, str) and t.strip():
                return t.strip()
    return ""


def _tool_args(tool: Mapping[str, Any]) -> dict[str, Any]:
    args = tool.get("args") or tool.get("arguments") or tool.get("input")
    if isinstance(args, Mapping):
        return dict(args)
    for key in tool:
        lk = str(key).lower()
        if "shell" in lk and isinstance(tool.get(key), Mapping):
            inner = _as_dict(tool.get(key))
            nested = inner.get("args") or inner.get("arguments") or inner.get("input")
            if isinstance(nested, Mapping):
                return dict(nested)
            return inner
    return {}


def _tool_result(tool: Mapping[str, Any]) -> dict[str, Any]:
    result = tool.get("result") or tool.get("output")
    if isinstance(result, Mapping):
        return dict(result)
    for key in tool:
        lk = str(key).lower()
        if "shell" in lk and isinstance(tool.get(key), Mapping):
            inner = _as_dict(tool.get(key))
            nested = inner.get("result") or inner.get("output")
            if isinstance(nested, Mapping):
                return dict(nested)
    return {}


def extract_shell_command(tool: Mapping[str, Any]) -> tuple[str, str]:
    """Return (command, working_directory) for a shell-like tool_call."""
    args = _tool_args(tool)
    cmd = (
        args.get("command")
        or args.get("cmd")
        or args.get("script")
        or ""
    )
    cwd = (
        args.get("workingDirectory")
        or args.get("working_directory")
        or args.get("cwd")
        or args.get("workdir")
        or ""
    )
    return str(cmd).strip(), str(cwd).strip()


def is_shell_tool(tool: Mapping[str, Any]) -> bool:
    t = _tool_type(tool).lower()
    if t in {"shell", "bash", "terminal", "run_terminal", "execute", "command", "pty"}:
        return True
    cmd, _ = extract_shell_command(tool)
    return bool(cmd) and t in {"", "tool"}


def _short_label(command: str) -> str:
    one = re.sub(r"\s+", " ", command).strip()
    if len(one) > 48:
        one = one[:45] + "…"
    return f"agent · {one}" if one else "agent · shell"


def event_text(event: Mapping[str, Any]) -> str:
    if not event:
        return ""
    for key in ("data", "text", "chunk", "stdout", "stderr", "output"):
        val = event.get(key)
        if isinstance(val, str) and val:
            return val
        if isinstance(val, (bytes, bytearray)):
            try:
                return val.decode("utf-8", errors="replace")
            except Exception:
                return str(val)
    # Nested: { stdout: { text } } / stream chunks
    for key in ("stdout", "stderr"):
        nested = event.get(key)
        if isinstance(nested, Mapping):
            t = nested.get("text") or nested.get("data") or nested.get("chunk")
            if isinstance(t, str) and t:
                return t
    return ""


async def mirror_on_tool_start(
    project_id: str,
    call_id: str,
    tool: Mapping[str, Any],
) -> Optional[dict[str, Any]]:
    """Spawn a display PTY for a shell tool. Returns fields to merge into tool-delta."""
    if not call_id or not is_shell_tool(tool):
        return None
    command, workdir = extract_shell_command(tool)
    if not command:
        return None

    async with _lock:
        if call_id in _mirrors:
            return {"sessionId": _mirrors[call_id], "name": "shell"}

    try:
        project = get_project(project_id)
        cwd = workdir or str(project.path)
    except Exception:
        cwd = workdir or "."

    try:
        # `cat` echoes whatever we write — display-only sink (SDK already runs the cmd).
        session = await pty_manager.spawn(
            ["bash", "-lc", "exec cat"],
            cwd=cwd,
            kind="shell",
            project_id=project_id,
            label=_short_label(command),
        )
        header = f"$ {command}\n\n"
        await pty_manager.write(session.id, header)
        async with _lock:
            _mirrors[call_id] = session.id
        log.info("agent shell mirror session=%s call=%s", session.id, call_id[:12])
        return {
            "sessionId": session.id,
            "name": "shell",
            "summary": command[:240],
        }
    except Exception as e:
        log.warning("agent shell mirror failed: %s", e)
        return None


async def mirror_shell_output(call_id: Optional[str], event: Mapping[str, Any]) -> None:
    text = event_text(event)
    if not text:
        return
    sid = None
    if call_id:
        async with _lock:
            sid = _mirrors.get(call_id)
    if not sid:
        # Fan-out to most recent mirror if call_id missing on delta
        async with _lock:
            if _mirrors:
                sid = next(reversed(list(_mirrors.values())))
    if not sid:
        return
    try:
        await pty_manager.write(sid, text)
    except Exception:
        pass


async def mirror_on_tool_complete(
    project_id: str,
    call_id: str,
    tool: Mapping[str, Any],
) -> Optional[dict[str, Any]]:
    if not call_id:
        return None
    async with _lock:
        sid = _mirrors.get(call_id)
    if not sid and is_shell_tool(tool):
        started = await mirror_on_tool_start(project_id, call_id, tool)
        if started:
            sid = str(started.get("sessionId") or "")
    if not sid:
        return None

    result = _tool_result(tool)
    parts: list[str] = []
    stdout = result.get("stdout") or result.get("output")
    stderr = result.get("stderr")
    if isinstance(stdout, str) and stdout.strip():
        # May already have been streamed; only append if session buffer is tiny
        sess = pty_manager.get(sid)
        buffered = "".join(sess.output_buffer) if sess else ""
        if stdout not in buffered and len(buffered) < len(stdout) + 20:
            parts.append(stdout if stdout.endswith("\n") else stdout + "\n")
    if isinstance(stderr, str) and stderr.strip():
        parts.append(stderr if stderr.endswith("\n") else stderr + "\n")
    code = result.get("exitCode")
    if code is None:
        code = result.get("exit_code")
    if code is not None:
        parts.append(f"\n[exit {code}]\n")
    else:
        parts.append("\n[done]\n")
    blob = "".join(parts)
    if blob:
        try:
            await pty_manager.write(sid, blob)
        except Exception:
            pass
    async with _lock:
        _mirrors.pop(call_id, None)
    command, _ = extract_shell_command(tool)
    return {
        "sessionId": sid,
        "name": "shell",
        "summary": command[:240] if command else None,
    }
