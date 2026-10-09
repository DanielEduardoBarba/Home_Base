from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any, AsyncIterator, Mapping, Optional

from .config import AGENTS_PATH, get_project, get_settings
from .cursor_env import ensure_cursor_bridge_env
from .homebase_tools import build_homebase_tools, wrap_prompt
from .notifications import push as notify
from .trace_log import append as trace_append

log = logging.getLogger("homebase.cursor")

# call_id → mirrored Shell PTY session id (for Show-in-Shell + sudo feed)
_shell_call_sessions: dict[str, str] = {}


def _is_active_run_conflict(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return "already has active run" in msg or "active run" in msg


def _load_agents() -> dict[str, str]:
    if not AGENTS_PATH.is_file():
        return {}
    try:
        return json.loads(AGENTS_PATH.read_text())
    except Exception:
        return {}


def _save_agents(data: dict[str, str]) -> None:
    AGENTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    AGENTS_PATH.write_text(json.dumps(data, indent=2))


def _agent_id(agent: Any) -> Optional[str]:
    return getattr(agent, "agent_id", None) or getattr(agent, "agentId", None)


def _model_label(model_id: str) -> str:
    mid = (model_id or "").strip()
    if mid.lower() == "auto":
        return "Auto"
    return mid


def _resolve_model(model: Optional[str] = None) -> str:
    settings = get_settings()
    chosen = (model or "").strip()
    return chosen or settings.cursor_model or "auto"


# UI modes (Cursor IDE parity). SDK wire only supports agent|plan; ask/debug
# are approximated (disallowed mutating tools / debug guidance).
_VALID_MODES = frozenset({"agent", "ask", "plan", "debug"})
_ASK_DISALLOWED = (
    "Shell",
    "Write",
    "Delete",
    "Edit",
    "StrReplace",
    "ApplyPatch",
    "DeleteFile",
    "WriteFile",
    "EditNotebook",
    "Task",
    "Await",
)
_DEBUG_PREFIX = (
    "[Home Base · Debug mode] Investigate root causes with hypotheses and "
    "runtime evidence before large edits. Prefer targeted instrumentation and "
    "a focused fix; clean up temporary logs when done.\n\n"
)
_ASK_PREFIX = (
    "[Home Base · Ask mode] Read-only: answer and explain. Do not edit files, "
    "run shell commands that change state, or ship/deploy. Use read/search tools only.\n\n"
)


def _resolve_mode(mode: Optional[str] = None) -> str:
    m = (mode or "agent").strip().lower()
    return m if m in _VALID_MODES else "agent"


def _sdk_mode(mode: str) -> str:
    """Map UI mode → cursor-sdk AgentModeOption."""
    return "plan" if mode == "plan" else "agent"


def _mode_prefix(mode: str) -> str:
    if mode == "ask":
        return _ASK_PREFIX
    if mode == "debug":
        return _DEBUG_PREFIX
    return ""


def _session_key(project_id: str, chat_id: str) -> str:
    cid = (chat_id or "default").strip() or "default"
    return f"{project_id}:{cid}"


def _resolve_cwd(project_id: str, cwd: Optional[str] = None) -> Path:
    project = get_project(project_id)
    root = project.path.resolve()
    rel = (cwd or "").strip().lstrip("/")
    if not rel or rel in {".", "./"}:
        return root
    target = (root / rel).resolve()
    try:
        target.relative_to(root)
    except ValueError as e:
        raise PermissionError("cwd escapes project root") from e
    if not target.is_dir():
        raise NotADirectoryError(f"cwd is not a directory: {rel}")
    return target


class CursorBridge:
    """Local Cursor agents via cursor-sdk (no cloud runtime)."""

    def __init__(self) -> None:
        self._client: Any = None
        self._client_workspace: Optional[str] = None
        self._agents: dict[str, Any] = {}
        self._active_run: dict[str, Any] = {}
        self._send_locks: dict[str, asyncio.Lock] = {}
        self._models: dict[str, str] = {}
        self._cwds: dict[str, str] = {}
        self._modes: dict[str, str] = {}
        # Full Home Base preamble once per session; short reminder after
        self._context_primed: set[str] = set()

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._send_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._send_locks[key] = lock
        return lock

    @property
    def configured(self) -> bool:
        return bool(get_settings().cursor_api_key)

    async def list_models(self) -> dict[str, Any]:
        settings = get_settings()
        default = (settings.cursor_model or "auto").strip() or "auto"
        auto_entry = {
            "id": "auto",
            "displayName": "Auto",
            "description": "Cursor picks the best model for the task",
        }
        if not settings.cursor_api_key:
            models = [auto_entry]
            if default != "auto":
                models.append(
                    {
                        "id": default,
                        "displayName": _model_label(default),
                        "description": "",
                    }
                )
            return {"configured": False, "default": default, "models": models}

        ensure_cursor_bridge_env()

        def _fetch() -> list[dict[str, str]]:
            from cursor_sdk import Cursor

            models = Cursor.models.list(api_key=settings.cursor_api_key)
            return [
                {
                    "id": m.id,
                    "displayName": _model_label(m.id)
                    if (m.id or "").lower() == "auto"
                    else (m.display_name or m.id),
                    "description": m.description or "",
                }
                for m in models
            ]

        try:
            models = await asyncio.to_thread(_fetch)
        except Exception as e:
            log.warning("list_models failed: %s", e)
            models = [auto_entry]
            if default != "auto":
                models.append(
                    {
                        "id": default,
                        "displayName": _model_label(default),
                        "description": "",
                    }
                )
            return {
                "configured": True,
                "default": default,
                "models": models,
                "error": str(e),
            }

        # Always offer Auto first — SDK may or may not include it in list().
        models = [m for m in models if (m.get("id") or "").lower() != "auto"]
        models.insert(0, auto_entry)
        if default != "auto" and not any(m["id"] == default for m in models):
            models.insert(
                1,
                {
                    "id": default,
                    "displayName": _model_label(default),
                    "description": "",
                },
            )

        return {"configured": True, "default": default, "models": models}

    async def _ensure_client(self, workspace: Path):
        ensure_cursor_bridge_env()
        from cursor_sdk import AsyncClient

        ws = str(workspace)
        if self._client is not None and self._client_workspace == ws:
            return self._client

        await self.close()

        client = await AsyncClient.launch_bridge(workspace=ws)
        if hasattr(client, "__aenter__") and not hasattr(client, "create_agent"):
            client = await client.__aenter__()
        self._client = client
        self._client_workspace = ws
        return client

    async def close(self) -> None:
        for key, agent in list(self._agents.items()):
            try:
                if hasattr(agent, "aclose"):
                    await agent.aclose()
                elif hasattr(agent, "__aexit__"):
                    await agent.__aexit__(None, None, None)
            except Exception:
                pass
        self._agents.clear()
        self._models.clear()
        self._cwds.clear()
        self._active_run.clear()
        self._send_locks.clear()
        self._context_primed.clear()
        if self._client is not None:
            try:
                if hasattr(self._client, "aclose"):
                    await self._client.aclose()
                elif hasattr(self._client, "shutdown"):
                    await self._client.shutdown()
                elif hasattr(self._client, "__aexit__"):
                    await self._client.__aexit__(None, None, None)
            except Exception:
                pass
        self._client = None
        self._client_workspace = None

    async def get_or_create_agent(
        self,
        project_id: str,
        *,
        chat_id: str = "default",
        cwd: Optional[str] = None,
        model: Optional[str] = None,
        mode: Optional[str] = None,
    ):
        from cursor_sdk import AgentOptions, AsyncAgent, LocalAgentOptions

        key = _session_key(project_id, chat_id)
        model_id = _resolve_model(model)
        ui_mode = _resolve_mode(mode)
        work_cwd = _resolve_cwd(project_id, cwd)
        ask_mode = ui_mode == "ask"

        # Ask uses a restricted toolset — recreate when crossing ask ↔ other modes.
        prev_mode = self._modes.get(key)
        if key in self._agents and prev_mode is not None:
            if (prev_mode == "ask") != ask_mode:
                await self.reset_agent(project_id, chat_id=chat_id)

        if key in self._agents:
            self._models[key] = model_id
            self._cwds[key] = str(work_cwd)
            self._modes[key] = ui_mode
            return self._agents[key]

        settings = get_settings()
        if not settings.cursor_api_key:
            raise RuntimeError("CURSOR_API_KEY is not set")

        project = get_project(project_id)
        # Bridge client is scoped to project root; agent cwd may be a subdirectory
        client = await self._ensure_client(project.path)
        stored = _load_agents()
        agent_id = stored.get(key) or stored.get(project_id)
        # Project rules/AGENTS.md + in-process Home Base control tools
        local = LocalAgentOptions(
            cwd=str(work_cwd),
            setting_sources=["project"],
            custom_tools=build_homebase_tools(project_id, readonly=ask_mode),
        )
        sdk_mode = _sdk_mode(ui_mode)
        base_opts: dict[str, Any] = {
            "api_key": settings.cursor_api_key,
            "model": model_id,
            "local": local,
            "name": f"Home Base · {project.name}",
            "mode": sdk_mode,
        }
        if ask_mode:
            base_opts["disallowed_tools"] = list(_ASK_DISALLOWED)

        if agent_id:
            try:
                options = AgentOptions(**base_opts)
                if hasattr(client, "resume_agent"):
                    agent = await client.resume_agent(agent_id, options)
                else:
                    agent = await AsyncAgent.resume(agent_id, options, client=client)
                self._agents[key] = agent
                self._models[key] = model_id
                self._cwds[key] = str(work_cwd)
                self._modes[key] = ui_mode
                return agent
            except Exception as e:
                log.warning("resume failed for %s: %s — creating new", key, e)

        options = AgentOptions(**base_opts)
        if hasattr(client, "create_agent"):
            agent = await client.create_agent(options)
        else:
            agent = await AsyncAgent.create(options, client=client)

        self._agents[key] = agent
        self._models[key] = model_id
        self._cwds[key] = str(work_cwd)
        self._modes[key] = ui_mode
        aid = _agent_id(agent)
        if aid:
            data = _load_agents()
            data[key] = aid
            _save_agents(data)
        return agent

    async def reset_agent(self, project_id: str, chat_id: str = "default") -> None:
        key = _session_key(project_id, chat_id)
        agent = self._agents.pop(key, None)
        self._models.pop(key, None)
        self._cwds.pop(key, None)
        self._modes.pop(key, None)
        self._active_run.pop(key, None)
        self._context_primed.discard(key)
        if agent:
            try:
                if hasattr(agent, "aclose"):
                    await agent.aclose()
                elif hasattr(agent, "__aexit__"):
                    await agent.__aexit__(None, None, None)
            except Exception:
                pass
        data = _load_agents()
        data.pop(key, None)
        # legacy single-agent key
        if chat_id in {"default", ""}:
            data.pop(project_id, None)
        _save_agents(data)

    def agent_info(
        self, project_id: str, chat_id: str = "default"
    ) -> dict[str, Any]:
        key = _session_key(project_id, chat_id)
        stored = _load_agents()
        agent = self._agents.get(key)
        aid = _agent_id(agent) if agent else None
        return {
            "projectId": project_id,
            "chatId": chat_id or "default",
            "agentId": aid or stored.get(key) or stored.get(project_id),
            "configured": self.configured,
            "active": key in self._agents,
            "running": key in self._active_run,
            "model": self._models.get(key) or get_settings().cursor_model,
            "defaultModel": get_settings().cursor_model,
            "mode": self._modes.get(key) or "agent",
            "cwd": self._cwds.get(key),
        }

    async def cancel(self, project_id: str, chat_id: str = "default") -> bool:
        key = _session_key(project_id, chat_id)
        run = self._active_run.get(key)
        ok = False
        if run:
            ok = await self._cancel_run_obj(run)
        agent = self._agents.get(key)
        if agent is not None:
            cleared = await self._cancel_agent_active_runs(agent)
            ok = ok or cleared
        if not run and not ok:
            return False
        return ok

    async def _cancel_run_obj(self, run: Any) -> bool:
        try:
            if hasattr(run, "supports") and not run.supports("cancel"):
                return False
            if hasattr(run, "cancel"):
                result = run.cancel()
                if hasattr(result, "__await__"):
                    await result
                return True
        except Exception as e:
            log.warning("cancel failed: %s", e)
        return False

    async def _cancel_agent_active_runs(self, agent: Any) -> bool:
        """Best-effort: cancel any SDK-side running runs for this agent."""
        aid = _agent_id(agent)
        client = getattr(agent, "client", None) or self._client
        if not aid or client is None or not hasattr(client, "list_runs"):
            return False
        cleared = False
        try:
            listed = await client.list_runs(aid, limit=20)
            items = getattr(listed, "items", None) or []
            for run in items:
                status = str(getattr(run, "status", "") or "").lower()
                if status not in {"running", "pending"}:
                    continue
                run_id = getattr(run, "id", None) or getattr(run, "run_id", None)
                if not run_id:
                    continue
                try:
                    await client.cancel_run(run_id, agent_id=aid)
                    cleared = True
                    log.info("cancelled stale run %s on agent %s", run_id, aid)
                except Exception as e:
                    log.warning("cancel_run %s failed: %s", run_id, e)
        except Exception as e:
            log.warning("list_runs for cancel failed: %s", e)
        return cleared

    async def _begin_run(
        self,
        agent: Any,
        send_text: str,
        model_id: str,
        *,
        key: str,
        mode: str = "agent",
    ) -> Any:
        from cursor_sdk import LocalSendOptions, SendOptions

        # Never steal a live tracked run — caller must Cancel first.
        if key in self._active_run:
            raise RuntimeError(
                "Agent is already working on this chat — wait or press Stop, then retry."
            )

        sdk_mode = _sdk_mode(mode)

        def _opts(*, force: bool) -> Any:
            return SendOptions(
                model=model_id,
                mode=sdk_mode,
                on_delta=_noop_delta,
                local=LocalSendOptions(force=force),
            )

        try:
            return await agent.send(send_text, _opts(force=False))
        except Exception as e:
            if not _is_active_run_conflict(e):
                raise
            # Orphaned SDK run (Home Base lost the handle). Expire via local.force.
            log.warning(
                "orphan active-run on %s — force-expire then retry: %s",
                key,
                e,
            )
            trace_append(
                "warn",
                f"cursor orphan active-run — force recovery ({key})",
                source="cursor",
                projectId=key.split(":", 1)[0],
            )
            await asyncio.sleep(0.15)
            return await agent.send(send_text, _opts(force=True))

    def _emit_error_event(
        self,
        project_id: str,
        chat_id: str,
        err: BaseException | str,
        *,
        key: str,
    ) -> dict[str, Any]:
        msg = str(err)
        if isinstance(err, BaseException):
            log.error("send_stream failed: %s", msg, exc_info=err)
        else:
            log.error("send_stream failed: %s", msg)
        try:
            pname = get_project(project_id).name
        except Exception:
            pname = project_id
        notify(
            "Cursor error",
            f"{pname}: {msg[:180]}",
            level="error",
            category="cursor",
            meta={"projectId": project_id, "chatId": chat_id},
        )
        trace_append(
            "error",
            f"cursor: {msg[:500]}",
            source="cursor",
            projectId=project_id,
            chatId=chat_id,
        )
        return {
            "type": "error",
            "error": msg,
            "chatId": chat_id,
            "recoverable": True,
            "running": key in self._active_run,
        }

    async def send_stream(
        self,
        project_id: str,
        prompt: str,
        *,
        model: Optional[str] = None,
        mode: Optional[str] = None,
        chat_id: str = "default",
        cwd: Optional[str] = None,
    ) -> AsyncIterator[dict[str, Any]]:
        key = _session_key(project_id, chat_id)
        model_id = _resolve_model(model)
        ui_mode = _resolve_mode(mode)
        lock = self._lock_for(key)

        if lock.locked() or key in self._active_run:
            yield {
                "type": "error",
                "error": "Agent is already working on this chat — wait or press Stop, then retry.",
                "chatId": chat_id,
                "recoverable": True,
                "busy": True,
            }
            return

        async with lock:
            try:
                agent = await self.get_or_create_agent(
                    project_id,
                    chat_id=chat_id,
                    cwd=cwd,
                    model=model_id,
                    mode=ui_mode,
                )
            except Exception as e:
                yield self._emit_error_event(project_id, chat_id, e, key=key)
                return

            aid = _agent_id(agent)
            if aid:
                data = _load_agents()
                data[key] = aid
                _save_agents(data)
                yield {
                    "type": "agent",
                    "agentId": aid,
                    "model": model_id,
                    "mode": ui_mode,
                    "chatId": chat_id,
                    "cwd": self._cwds.get(key),
                }

            # Full Home Base identity once per session; tools stay on the agent.
            prefix = _mode_prefix(ui_mode)
            if key not in self._context_primed:
                send_text = wrap_prompt(
                    prompt,
                    project_id,
                    chat_id=chat_id,
                    cwd=self._cwds.get(key),
                )
                self._context_primed.add(key)
            else:
                send_text = prompt
            if prefix and not send_text.startswith(prefix.strip()[:20]):
                send_text = prefix + send_text

            try:
                # on_delta enables enableDeltas on the wire — without it, thinking/text
                # arrive as complete messages only (feels like one dump at the end).
                run = await self._begin_run(
                    agent, send_text, model_id, key=key, mode=ui_mode
                )
            except Exception as e:
                yield self._emit_error_event(project_id, chat_id, e, key=key)
                return

            self._models[key] = model_id
            self._modes[key] = ui_mode
            self._active_run[key] = run
            run_id = getattr(run, "id", None) or getattr(run, "run_id", None)
            yield {
                "type": "run",
                "runId": run_id,
                "model": model_id,
                "mode": ui_mode,
                "chatId": chat_id,
            }

            try:
                # Prefer events(): yields interaction_update deltas + sdk_message.
                # stream()/messages() only forward sdk_message (no live deltas).
                if hasattr(run, "events"):
                    async for event in run.events():
                        update = getattr(event, "interaction_update", None)
                        if update is not None:
                            payload = await _handle_interaction(
                                project_id, chat_id, update
                            )
                            if payload:
                                yield payload
                        message = getattr(event, "sdk_message", None)
                        if message is not None:
                            yield {
                                "type": "message",
                                "chatId": chat_id,
                                "message": _serialize_message(message),
                            }
                elif hasattr(run, "stream"):
                    async for message in run.stream():
                        yield {
                            "type": "message",
                            "chatId": chat_id,
                            "message": _serialize_message(message),
                        }
                elif hasattr(run, "iter_text"):
                    async for text in run.iter_text():
                        if text:
                            yield {
                                "type": "text-delta",
                                "text": text,
                                "chatId": chat_id,
                            }

                result = await run.wait()
                status = getattr(result, "status", "finished")
                try:
                    pname = get_project(project_id).name
                except Exception:
                    pname = project_id
                err = str(status).lower() in {"error", "failed"}
                notify(
                    "Cursor finished with error" if err else "Cursor finished",
                    f"{pname} · chat ready to check",
                    level="error" if err else "success",
                    category="cursor",
                    meta={
                        "projectId": project_id,
                        "chatId": chat_id,
                        "status": str(status),
                        "runId": run_id,
                    },
                )
                if err:
                    trace_append(
                        "error",
                        f"cursor run ended with status={status}",
                        source="cursor",
                        projectId=project_id,
                        chatId=chat_id,
                        runId=run_id,
                    )
                yield {
                    "type": "done",
                    "status": status,
                    "runId": run_id,
                    "chatId": chat_id,
                    "result": _safe_result(result),
                    "recoverable": True,
                }
            except Exception as e:
                yield self._emit_error_event(project_id, chat_id, e, key=key)
            finally:
                self._active_run.pop(key, None)


def _noop_delta(_update: Any) -> None:
    """SendOptions requires on_delta to flip enableDeltas=true; body unused."""
    return None


async def _handle_interaction(
    project_id: str, chat_id: str, update: Any
) -> Optional[dict[str, Any]]:
    """Serialize an interaction update and mirror agent shells into Shell PTYs."""
    from . import agent_shell_mirror as asm

    utype = getattr(update, "type", None)
    if utype == "shell-output-delta":
        event = getattr(update, "event", None) or {}
        if not isinstance(event, Mapping):
            event = {}
        call_id = (
            event.get("callId")
            or event.get("call_id")
            or event.get("toolCallId")
            or None
        )
        await asm.mirror_shell_output(str(call_id) if call_id else None, event)
        sid = _shell_call_sessions.get(str(call_id)) if call_id else None
        text = asm._event_text(event)
        if not text:
            return None
        payload: dict[str, Any] = {
            "type": "shell-delta",
            "chatId": chat_id,
            "callId": call_id,
            "text": text[-2000:],
        }
        if sid:
            payload["sessionId"] = sid
        try:
            from .sudo_auth import detect_sudo_prompt

            if detect_sudo_prompt(text):
                payload["sudoPrompt"] = True
                log.info(
                    "sudo prompt in shell-delta chat=%s call=%s session=%s",
                    chat_id,
                    str(call_id or "")[:12],
                    sid or "-",
                )
                trace_append(
                    "warn",
                    f"sudo prompt detected chat={chat_id}",
                    source="cursor",
                    projectId=project_id,
                    chatId=chat_id,
                )
        except Exception:
            pass
        return payload

    payload = _serialize_delta(update)
    if not payload:
        return None
    payload["chatId"] = chat_id

    if payload.get("type") == "tool-delta":
        tool = getattr(update, "tool_call", None) or {}
        if not isinstance(tool, Mapping):
            tool = {}
        call_id = str(payload.get("callId") or "")
        phase = payload.get("phase")
        extra: Optional[dict[str, Any]] = None
        if phase == "tool-call-started" and call_id:
            extra = await asm.mirror_on_tool_start(project_id, call_id, tool)
        elif phase == "tool-call-completed" and call_id:
            extra = await asm.mirror_on_tool_complete(project_id, call_id, tool)
        if extra:
            if extra.get("sessionId"):
                payload["sessionId"] = extra["sessionId"]
                if call_id:
                    _shell_call_sessions[call_id] = str(extra["sessionId"])
            if extra.get("name"):
                payload["name"] = extra["name"]
            if extra.get("summary"):
                payload["summary"] = extra["summary"]
    return payload


def _tool_display_name(tool: Mapping[str, Any]) -> str:
    for key in ("type", "name", "toolName", "tool_name"):
        v = tool.get(key)
        if isinstance(v, str) and v.strip() and v.strip().lower() != "tool":
            return v.strip()
    for key in tool:
        lk = str(key).lower()
        if lk.endswith("toolcall") or lk.endswith("_tool_call") or "shell" in lk:
            if "shell" in lk:
                return "shell"
            if "read" in lk:
                return "read"
            if "edit" in lk or "write" in lk:
                return "edit"
            if "grep" in lk or "search" in lk:
                return "grep"
            if "glob" in lk:
                return "glob"
            if "delete" in lk:
                return "delete"
    return "tool"


def _flatten_tool_args(tool: Mapping[str, Any]) -> Any:
    args = tool.get("args") or tool.get("arguments") or tool.get("input")
    if args is not None:
        return args
    for key in tool:
        lk = str(key).lower()
        if isinstance(tool.get(key), Mapping) and (
            "toolcall" in lk or "shell" in lk or lk.endswith("call")
        ):
            inner = dict(tool[key])  # type: ignore[arg-type]
            nested = inner.get("args") or inner.get("arguments") or inner.get("input")
            if nested is not None:
                return nested
            return inner
    return None


def _tool_summary(name: str, args: Any) -> str:
    """Human one-liner for chat tool cards (no raw JSON)."""
    n = (name or "tool").lower()
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:
            s = args.strip()
            return s[:240] if s else name

    if not isinstance(args, dict):
        return name

    path = ""
    for key in ("path", "file", "filePath", "filename", "target", "target_file"):
        val = args.get(key)
        if isinstance(val, str) and val.strip():
            path = val.strip()
            break

    if n in {"shell", "bash", "terminal", "execute", "command", "pty"}:
        cmd = str(args.get("command") or args.get("cmd") or "").strip()
        return cmd[:240] if cmd else "shell"

    if n in {"read", "read_file", "readfile"}:
        return f"Read {path}" if path else "Read file"
    if n in {"write", "write_file", "writefile"}:
        return f"Write {path}" if path else "Write file"
    if n in {"edit", "strreplace", "search_replace", "apply_patch", "edit_file"}:
        return f"Edit {path}" if path else "Edit file"
    if n in {"delete", "delete_file"}:
        return f"Delete {path}" if path else "Delete file"
    if n in {"grep", "rg", "search"}:
        pat = str(args.get("pattern") or args.get("query") or "").strip()
        where = path or str(args.get("glob") or args.get("path") or "").strip()
        if pat and where:
            return f"Search “{pat[:80]}” in {where}"
        if pat:
            return f"Search “{pat[:120]}”"
        return "Search"
    if n in {"glob", "list_dir", "ls", "listdir"}:
        g = str(args.get("glob_pattern") or args.get("glob") or path or "").strip()
        return f"List {g}" if g else "List files"
    if n.startswith("homebase_"):
        return n.replace("_", " ")
    if path:
        return f"{name} {path}"
    # Last resort: short key=value, not full JSON dump
    bits = []
    for k, v in list(args.items())[:3]:
        if isinstance(v, (str, int, float, bool)) and v != "":
            bits.append(f"{k}={str(v)[:60]}")
    return " · ".join(bits) if bits else name


def _serialize_delta(update: Any) -> Optional[dict[str, Any]]:
    """Map SDK InteractionUpdate → WS payload for live UI streaming."""
    utype = getattr(update, "type", None)
    if utype == "text-delta":
        text = getattr(update, "text", "") or ""
        return {"type": "text-delta", "text": text} if text else None
    if utype == "thinking-delta":
        text = getattr(update, "text", "") or ""
        return {"type": "thinking-delta", "text": text} if text else None
    if utype == "thinking-completed":
        return {
            "type": "thinking-completed",
            "ms": getattr(update, "thinking_duration_ms", None),
        }
    if utype in {"tool-call-started", "partial-tool-call", "tool-call-completed"}:
        tool = getattr(update, "tool_call", None) or {}
        if not isinstance(tool, Mapping):
            tool = {}
        name = _tool_display_name(tool)
        status = (
            "completed"
            if utype == "tool-call-completed"
            else "running"
        )
        call_id = getattr(update, "call_id", None) or tool.get("callId") or tool.get("id")
        args = _flatten_tool_args(tool)
        hint = _file_hint_from_args(args) or _file_hint_from_args(tool)
        summary = _tool_summary(name, args)
        out: dict[str, Any] = {
            "type": "tool-delta",
            "callId": call_id,
            "name": str(name),
            "status": status,
            "phase": utype,
            "summary": summary,
        }
        if args is not None:
            try:
                out["args"] = (
                    args
                    if isinstance(args, (dict, list, str, int, float, bool))
                    else str(args)[:800]
                )
            except Exception:
                out["args"] = str(args)[:800]
        if hint:
            out["file"] = hint
        return out
    if utype in {"step-started", "step-completed", "token-delta", "turn-ended"}:
        return {
            "type": "status-delta",
            "phase": utype,
            "text": str(utype).replace("-", " "),
        }
    return None


def _file_hint_from_args(args: Any) -> Optional[dict[str, str]]:
    if args is None:
        return None
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:
            m = re.search(r"[\w./\\-]+\.\w{1,12}", args)
            return {"path": m.group(0), "action": "touch"} if m else None
    if isinstance(args, dict):
        for key in ("path", "file", "filePath", "filename", "target", "target_file"):
            val = args.get(key)
            if isinstance(val, str) and val.strip():
                action = "edit"
                if any(k in args for k in ("contents", "content", "new_string", "newString")):
                    action = "write"
                elif "old_string" in args or "oldString" in args:
                    action = "edit"
                elif key in ("path", "file", "filePath") and not any(
                    k in args for k in ("old_string", "oldString", "new_string", "newString", "contents", "content")
                ):
                    # Likely a read when only path is present
                    action = "read"
                return {"path": val.strip(), "action": action}
    return None


def _serialize_message(message: Any) -> dict[str, Any]:
    mtype = getattr(message, "type", None) or getattr(message, "role", None)
    out: dict[str, Any] = {"type": mtype}

    if mtype == "thinking":
        out["text"] = getattr(message, "text", "") or ""
        out["content"] = [{"type": "text", "text": out["text"]}]
        return out

    if mtype == "tool_call":
        # SDK may put the real type on the message or nested tool payload
        raw_tool = {}
        for attr in ("tool_call", "toolCall", "tool"):
            cand = getattr(message, attr, None)
            if isinstance(cand, Mapping):
                raw_tool = dict(cand)
                break
        name = (
            getattr(message, "name", None)
            or getattr(message, "type", None)
            or _tool_display_name(raw_tool)
            or "tool"
        )
        if str(name).lower() in {"tool_call", "toolcall"}:
            name = _tool_display_name(raw_tool) or "tool"
        status = getattr(message, "status", "") or ""
        args = getattr(message, "args", None)
        if args is None:
            args = _flatten_tool_args(raw_tool)
        result = getattr(message, "result", None)
        out["name"] = str(name)
        out["status"] = status
        out["callId"] = getattr(message, "call_id", None) or getattr(message, "callId", None)
        out["summary"] = _tool_summary(str(name), args)
        try:
            out["args"] = args if isinstance(args, (dict, list, str, int, float, bool)) or args is None else str(args)[:2000]
        except Exception:
            out["args"] = str(args)[:2000]
        try:
            out["result"] = (
                result
                if isinstance(result, (dict, list, str, int, float, bool)) or result is None
                else str(result)[:2000]
            )
        except Exception:
            out["result"] = str(result)[:2000]
        hint = _file_hint_from_args(args)
        if hint:
            out["file"] = hint
        out["content"] = [{"type": "text", "text": out["summary"] or f"{name} · {status}"}]
        return out

    if mtype in {"status", "task"}:
        text = getattr(message, "message", None) or getattr(message, "text", "") or ""
        out["status"] = getattr(message, "status", "")
        out["text"] = text
        out["content"] = [{"type": "text", "text": str(text)}]
        return out

    inner = getattr(message, "message", None)
    if inner is not None:
        content = getattr(inner, "content", None)
        if content is not None:
            blocks = []
            for block in content:
                btype = getattr(block, "type", None)
                if btype == "text":
                    blocks.append({"type": "text", "text": getattr(block, "text", "")})
                elif btype == "tool_use":
                    blocks.append(
                        {
                            "type": "tool_use",
                            "name": getattr(block, "name", "tool"),
                            "raw": str(block)[:2000],
                        }
                    )
                else:
                    blocks.append({"type": str(btype), "raw": str(block)[:2000]})
            out["content"] = blocks
        else:
            out["content"] = [{"type": "text", "text": str(inner)[:4000]}]
    elif hasattr(message, "text"):
        out["content"] = [{"type": "text", "text": getattr(message, "text", "")}]
    else:
        try:
            if hasattr(message, "model_dump"):
                out["raw"] = message.model_dump()
            else:
                out["raw"] = str(message)[:4000]
        except Exception:
            out["raw"] = str(message)[:4000]
    return out


def _safe_result(result: Any) -> dict[str, Any]:
    return {
        "status": getattr(result, "status", None),
        "id": getattr(result, "id", None),
    }


cursor_bridge = CursorBridge()
