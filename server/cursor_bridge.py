from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any, AsyncIterator, Mapping, Optional

from .config import AGENTS_PATH, get_project, get_settings
from .cursor_env import ensure_cursor_bridge_env
from .notifications import push as notify

log = logging.getLogger("homebase.cursor")


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


def _resolve_model(model: Optional[str] = None) -> str:
    settings = get_settings()
    chosen = (model or "").strip()
    return chosen or settings.cursor_model


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
        self._models: dict[str, str] = {}
        self._cwds: dict[str, str] = {}

    @property
    def configured(self) -> bool:
        return bool(get_settings().cursor_api_key)

    async def list_models(self) -> dict[str, Any]:
        settings = get_settings()
        default = settings.cursor_model
        if not settings.cursor_api_key:
            return {
                "configured": False,
                "default": default,
                "models": [{"id": default, "displayName": default, "description": ""}],
            }

        ensure_cursor_bridge_env()

        def _fetch() -> list[dict[str, str]]:
            from cursor_sdk import Cursor

            models = Cursor.models.list(api_key=settings.cursor_api_key)
            return [
                {
                    "id": m.id,
                    "displayName": m.display_name or m.id,
                    "description": m.description or "",
                }
                for m in models
            ]

        try:
            models = await asyncio.to_thread(_fetch)
        except Exception as e:
            log.warning("list_models failed: %s", e)
            return {
                "configured": True,
                "default": default,
                "models": [{"id": default, "displayName": default, "description": ""}],
                "error": str(e),
            }

        if not any(m["id"] == default for m in models):
            models.insert(0, {"id": default, "displayName": default, "description": ""})

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
    ):
        from cursor_sdk import AsyncAgent, LocalAgentOptions

        key = _session_key(project_id, chat_id)
        model_id = _resolve_model(model)
        work_cwd = _resolve_cwd(project_id, cwd)

        if key in self._agents:
            self._models[key] = model_id
            self._cwds[key] = str(work_cwd)
            return self._agents[key]

        settings = get_settings()
        if not settings.cursor_api_key:
            raise RuntimeError("CURSOR_API_KEY is not set")

        project = get_project(project_id)
        # Bridge client is scoped to project root; agent cwd may be a subdirectory
        client = await self._ensure_client(project.path)
        stored = _load_agents()
        agent_id = stored.get(key) or stored.get(project_id)
        local = LocalAgentOptions(cwd=str(work_cwd))

        if agent_id:
            try:
                options = {
                    "api_key": settings.cursor_api_key,
                    "model": model_id,
                    "local": local,
                }
                if hasattr(client, "resume_agent"):
                    agent = await client.resume_agent(agent_id, options)
                else:
                    agent = await AsyncAgent.resume(agent_id, options, client=client)
                self._agents[key] = agent
                self._models[key] = model_id
                self._cwds[key] = str(work_cwd)
                return agent
            except Exception as e:
                log.warning("resume failed for %s: %s — creating new", key, e)

        if hasattr(client, "create_agent"):
            agent = await client.create_agent(
                model=model_id,
                api_key=settings.cursor_api_key,
                local=local,
            )
        else:
            agent = await AsyncAgent.create(
                client=client,
                model=model_id,
                api_key=settings.cursor_api_key,
                local=local,
            )

        self._agents[key] = agent
        self._models[key] = model_id
        self._cwds[key] = str(work_cwd)
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
        self._active_run.pop(key, None)
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
            "cwd": self._cwds.get(key),
        }

    async def cancel(self, project_id: str, chat_id: str = "default") -> bool:
        key = _session_key(project_id, chat_id)
        run = self._active_run.get(key)
        if not run:
            return False
        try:
            if hasattr(run, "supports") and run.supports("cancel"):
                result = run.cancel()
                if hasattr(result, "__await__"):
                    await result
                return True
            if hasattr(run, "cancel"):
                result = run.cancel()
                if hasattr(result, "__await__"):
                    await result
                return True
        except Exception as e:
            log.warning("cancel failed: %s", e)
        return False

    async def send_stream(
        self,
        project_id: str,
        prompt: str,
        *,
        model: Optional[str] = None,
        chat_id: str = "default",
        cwd: Optional[str] = None,
    ) -> AsyncIterator[dict[str, Any]]:
        from cursor_sdk import SendOptions

        key = _session_key(project_id, chat_id)
        model_id = _resolve_model(model)
        agent = await self.get_or_create_agent(
            project_id, chat_id=chat_id, cwd=cwd, model=model_id
        )
        aid = _agent_id(agent)
        if aid:
            data = _load_agents()
            data[key] = aid
            _save_agents(data)
            yield {
                "type": "agent",
                "agentId": aid,
                "model": model_id,
                "chatId": chat_id,
                "cwd": self._cwds.get(key),
            }

        # on_delta enables enableDeltas on the wire — without it, thinking/text
        # arrive as complete messages only (feels like one dump at the end).
        run = await agent.send(
            prompt,
            SendOptions(model=model_id, on_delta=_noop_delta),
        )
        self._models[key] = model_id
        self._active_run[key] = run
        run_id = getattr(run, "id", None) or getattr(run, "run_id", None)
        yield {"type": "run", "runId": run_id, "model": model_id, "chatId": chat_id}

        try:
            # Prefer events(): yields interaction_update deltas + sdk_message.
            # stream()/messages() only forward sdk_message (no live deltas).
            if hasattr(run, "events"):
                async for event in run.events():
                    update = getattr(event, "interaction_update", None)
                    if update is not None:
                        payload = _serialize_delta(update)
                        if payload:
                            payload["chatId"] = chat_id
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
                        yield {"type": "text-delta", "text": text, "chatId": chat_id}

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
            yield {
                "type": "done",
                "status": status,
                "runId": run_id,
                "result": _safe_result(result),
            }
        except Exception as e:
            log.exception("send_stream failed")
            try:
                pname = get_project(project_id).name
            except Exception:
                pname = project_id
            notify(
                "Cursor error",
                f"{pname}: {str(e)[:180]}",
                level="error",
                category="cursor",
                meta={"projectId": project_id, "chatId": chat_id},
            )
            yield {"type": "error", "error": str(e)}
        finally:
            self._active_run.pop(key, None)


def _noop_delta(_update: Any) -> None:
    """SendOptions requires on_delta to flip enableDeltas=true; body unused."""
    return None


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
        name = (
            tool.get("name")
            or tool.get("toolName")
            or tool.get("tool_name")
            or "tool"
        )
        status = (
            "completed"
            if utype == "tool-call-completed"
            else "running"
        )
        call_id = getattr(update, "call_id", None) or tool.get("callId") or tool.get("id")
        args = tool.get("args") or tool.get("arguments") or tool.get("input")
        hint = _file_hint_from_args(args)
        out: dict[str, Any] = {
            "type": "tool-delta",
            "callId": call_id,
            "name": str(name),
            "status": status,
            "phase": utype,
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
        for key in ("path", "file", "filePath", "filename", "target"):
            val = args.get(key)
            if isinstance(val, str) and val.strip():
                action = "edit"
                if any(k in args for k in ("contents", "content", "new_string", "newString")):
                    action = "write"
                elif "old_string" in args or "oldString" in args:
                    action = "edit"
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
        name = getattr(message, "name", "") or "tool"
        status = getattr(message, "status", "") or ""
        args = getattr(message, "args", None)
        result = getattr(message, "result", None)
        out["name"] = name
        out["status"] = status
        out["callId"] = getattr(message, "call_id", None) or getattr(message, "callId", None)
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
        out["content"] = [{"type": "text", "text": f"{name} · {status}"}]
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
