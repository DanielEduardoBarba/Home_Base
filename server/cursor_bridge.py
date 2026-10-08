from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from .config import AGENTS_PATH, get_project, get_settings

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


class CursorBridge:
    """Local Cursor agents via cursor-sdk (no cloud runtime)."""

    def __init__(self) -> None:
        self._client: Any = None
        self._client_workspace: Optional[str] = None
        self._agents: dict[str, Any] = {}
        self._active_run: dict[str, Any] = {}

    @property
    def configured(self) -> bool:
        return bool(get_settings().cursor_api_key)

    async def _ensure_client(self, workspace: Path):
        from cursor_sdk import AsyncClient

        ws = str(workspace)
        if self._client is not None and self._client_workspace == ws:
            return self._client

        await self.close()

        # launch_bridge returns an AsyncClient (also supports async context manager)
        client = await AsyncClient.launch_bridge(workspace=ws)
        # Enter if it is a context manager wrapper
        if hasattr(client, "__aenter__") and not hasattr(client, "create_agent"):
            client = await client.__aenter__()
        self._client = client
        self._client_workspace = ws
        return client

    async def close(self) -> None:
        for pid, agent in list(self._agents.items()):
            try:
                if hasattr(agent, "aclose"):
                    await agent.aclose()
                elif hasattr(agent, "__aexit__"):
                    await agent.__aexit__(None, None, None)
            except Exception:
                pass
        self._agents.clear()
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

    async def get_or_create_agent(self, project_id: str):
        from cursor_sdk import AsyncAgent, LocalAgentOptions

        if project_id in self._agents:
            return self._agents[project_id]

        settings = get_settings()
        if not settings.cursor_api_key:
            raise RuntimeError("CURSOR_API_KEY is not set")

        project = get_project(project_id)
        client = await self._ensure_client(project.path)
        stored = _load_agents()
        agent_id = stored.get(project_id)
        local = LocalAgentOptions(cwd=str(project.path))

        if agent_id:
            try:
                options = {
                    "api_key": settings.cursor_api_key,
                    "model": settings.cursor_model,
                    "local": local,
                }
                if hasattr(client, "resume_agent"):
                    agent = await client.resume_agent(agent_id, options)
                else:
                    agent = await AsyncAgent.resume(agent_id, options, client=client)
                self._agents[project_id] = agent
                return agent
            except Exception as e:
                log.warning("resume failed for %s: %s — creating new", project_id, e)

        # Prefer client.create_agent when available
        if hasattr(client, "create_agent"):
            agent = await client.create_agent(
                model=settings.cursor_model,
                api_key=settings.cursor_api_key,
                local=local,
            )
        else:
            agent = await AsyncAgent.create(
                client=client,
                model=settings.cursor_model,
                api_key=settings.cursor_api_key,
                local=local,
            )

        self._agents[project_id] = agent
        aid = _agent_id(agent)
        if aid:
            data = _load_agents()
            data[project_id] = aid
            _save_agents(data)
        return agent

    async def reset_agent(self, project_id: str) -> None:
        agent = self._agents.pop(project_id, None)
        if agent:
            try:
                if hasattr(agent, "aclose"):
                    await agent.aclose()
                elif hasattr(agent, "__aexit__"):
                    await agent.__aexit__(None, None, None)
            except Exception:
                pass
        data = _load_agents()
        data.pop(project_id, None)
        _save_agents(data)

    def agent_info(self, project_id: str) -> dict[str, Any]:
        stored = _load_agents()
        agent = self._agents.get(project_id)
        aid = _agent_id(agent) if agent else None
        return {
            "projectId": project_id,
            "agentId": aid or stored.get(project_id),
            "configured": self.configured,
            "active": project_id in self._agents,
            "running": project_id in self._active_run,
        }

    async def cancel(self, project_id: str) -> bool:
        run = self._active_run.get(project_id)
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
        self, project_id: str, prompt: str
    ) -> AsyncIterator[dict[str, Any]]:
        agent = await self.get_or_create_agent(project_id)
        aid = _agent_id(agent)
        if aid:
            data = _load_agents()
            data[project_id] = aid
            _save_agents(data)
            yield {"type": "agent", "agentId": aid}

        run = await agent.send(prompt)
        self._active_run[project_id] = run
        run_id = getattr(run, "id", None) or getattr(run, "run_id", None)
        yield {"type": "run", "runId": run_id}

        try:
            if hasattr(run, "iter_text"):
                async for text in run.iter_text():
                    if text:
                        yield {"type": "text", "text": text}
            elif hasattr(run, "messages"):
                async for message in run.messages():
                    yield {"type": "message", "message": _serialize_message(message)}
            elif hasattr(run, "stream"):
                async for message in run.stream():
                    yield {"type": "message", "message": _serialize_message(message)}

            result = await run.wait()
            yield {
                "type": "done",
                "status": getattr(result, "status", "finished"),
                "runId": run_id,
                "result": _safe_result(result),
            }
        except Exception as e:
            log.exception("send_stream failed")
            yield {"type": "error", "error": str(e)}
        finally:
            self._active_run.pop(project_id, None)


def _serialize_message(message: Any) -> dict[str, Any]:
    mtype = getattr(message, "type", None) or getattr(message, "role", None)
    out: dict[str, Any] = {"type": mtype}

    inner = getattr(message, "message", None)
    if inner is not None:
        content = getattr(inner, "content", None)
        if content is not None:
            blocks = []
            for block in content:
                btype = getattr(block, "type", None)
                if btype == "text":
                    blocks.append({"type": "text", "text": getattr(block, "text", "")})
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
