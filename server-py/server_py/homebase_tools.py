"""Cursor SDK custom tools that call Home Base in-process (no JWT hop)."""

from __future__ import annotations

import json
from typing import Any, Mapping, Optional

from cursor_sdk import CustomTool, CustomToolContext

from .config import get_project, get_settings, list_projects, load_projects
from .health import project_port_status
from .notifications import list_notifications, push as notify
from .process_manager import list_projects_meta, stop_project, tail_logs, trigger_action
from .pty_manager import pty_manager
from .system_ctl import list_wireguard, unit_active
from .version import status_payload


CONTEXT_MARKER = "[Home Base context]"


def build_context_preamble(
    project_id: str,
    *,
    chat_id: str = "default",
    cwd: Optional[str] = None,
) -> str:
    """Minimal identity for the first turn — keep short to avoid echo/stutter in replies."""
    try:
        project = get_project(project_id)
        name = project.name
        path = str(project.path)
    except Exception:
        name = project_id
        path = "?"

    settings = get_settings()
    ver = status_payload().get("version", "?")
    cwd_bit = f" · cwd {cwd}" if cwd else ""

    return (
        f"{CONTEXT_MARKER}\n"
        f"Private metadata (do not quote, paraphrase, or repeat):\n"
        f"UI=Home Base v{ver} (not Cursor IDE) · bind {settings.host}:{settings.port} · "
        f"project {name} ({project_id}) @ {path} · chat {chat_id or 'default'}{cwd_bit}. "
        f"For control-plane ops use homebase_* tools only; code/file work uses normal tools. "
        f"Answer the user message below in a normal concise voice.\n"
        f"---\n"
    )


def wrap_prompt(
    prompt: str,
    project_id: str,
    *,
    chat_id: str = "default",
    cwd: Optional[str] = None,
) -> str:
    text = (prompt or "").strip()
    if text.startswith(CONTEXT_MARKER):
        return text
    return build_context_preamble(project_id, chat_id=chat_id, cwd=cwd) + text


def _json(data: Any) -> str:
    return json.dumps(data, default=str, indent=2)


def _resolve_project_id(args: Mapping[str, Any], default: str) -> str:
    pid = str(args.get("projectId") or args.get("project_id") or "").strip()
    return pid or default


def build_homebase_tools(
    project_id: str, *, readonly: bool = False
) -> dict[str, CustomTool]:
    """In-process tools scoped with a default project (overridable via projectId)."""

    async def list_projects_tool(
        args: Mapping[str, Any], _ctx: CustomToolContext
    ) -> str:
        load_projects(force=True)
        out = []
        for meta in list_projects_meta():
            try:
                project = get_project(meta["id"])
                ports = await project_port_status(project)
            except Exception as e:
                ports = [{"error": str(e)}]
            sessions = pty_manager.list_sessions(meta["id"])
            out.append(
                {
                    **meta,
                    "portsStatus": ports,
                    "sessions": sessions,
                    "active": meta["id"] == project_id,
                }
            )
        return _json({"projects": out, "activeProjectId": project_id})

    async def project_status_tool(
        args: Mapping[str, Any], _ctx: CustomToolContext
    ) -> str:
        pid = _resolve_project_id(args, project_id)
        project = get_project(pid)
        ports = await project_port_status(project)
        return _json(
            {
                **project.to_public(),
                "portsStatus": ports,
                "sessions": pty_manager.list_sessions(pid),
                "logs": tail_logs(pid, int(args.get("logLines") or 40)),
            }
        )

    async def run_action_tool(
        args: Mapping[str, Any], _ctx: CustomToolContext
    ) -> str:
        pid = _resolve_project_id(args, project_id)
        action_id = str(args.get("actionId") or args.get("action_id") or "").strip()
        if not action_id:
            raise ValueError("actionId is required")
        extra = args.get("extraArgs") or args.get("extra_args")
        if extra is not None and not isinstance(extra, list):
            raise ValueError("extraArgs must be a list of strings")
        result = await trigger_action(
            pid, action_id, extra_args=[str(x) for x in (extra or [])] or None
        )
        return _json({"ok": True, "projectId": pid, "actionId": action_id, "result": result})

    async def stop_tool(args: Mapping[str, Any], _ctx: CustomToolContext) -> str:
        pid = _resolve_project_id(args, project_id)
        result = await stop_project(pid)
        return _json({"ok": True, "projectId": pid, **result})

    def logs_tool(args: Mapping[str, Any], _ctx: CustomToolContext) -> str:
        pid = _resolve_project_id(args, project_id)
        lines = int(args.get("lines") or 120)
        return _json(tail_logs(pid, max(1, min(lines, 2000))))

    def sessions_tool(args: Mapping[str, Any], _ctx: CustomToolContext) -> str:
        pid = str(args.get("projectId") or args.get("project_id") or "").strip() or None
        return _json({"sessions": pty_manager.list_sessions(pid)})

    def notify_tool(args: Mapping[str, Any], _ctx: CustomToolContext) -> str:
        title = str(args.get("title") or "").strip()
        if not title:
            raise ValueError("title is required")
        body = str(args.get("body") or "")
        level = str(args.get("level") or "info")
        if level not in {"info", "warn", "error", "success"}:
            level = "info"
        item = notify(
            title,
            body,
            level=level,
            category="cursor",
            meta={"projectId": project_id, "source": "homebase_notify"},
        )
        return _json(item)

    def inbox_tool(args: Mapping[str, Any], _ctx: CustomToolContext) -> str:
        limit = int(args.get("limit") or 20)
        unread_only = bool(args.get("unreadOnly") or args.get("unread_only") or False)
        return _json(
            list_notifications(
                offset=int(args.get("offset") or 0),
                limit=max(1, min(limit, 100)),
                unread_only=unread_only,
            )
        )

    async def host_status_tool(
        args: Mapping[str, Any], _ctx: CustomToolContext
    ) -> str:
        settings = get_settings()
        wg = list_wireguard()
        units = []
        for iface in wg:
            try:
                active = await unit_active(iface["unit"])
            except Exception as e:
                active = False
                iface = {**iface, "error": str(e)}
            units.append({**iface, "active": active})
        try:
            homebased_active = await unit_active("homebased.service")
        except Exception:
            homebased_active = None
        from .network import advertise_host

        return _json(
            {
                **status_payload(),
                "bind": {"host": settings.host, "port": settings.port},
                "advertiseHost": advertise_host(),
                "homebasedActive": homebased_active,
                "wireguard": units,
                "projectCount": len(list_projects()),
                "activeProjectId": project_id,
            }
        )

    tools = {
        "homebase_list_projects": CustomTool(
            execute=list_projects_tool,
            description=(
                "List Home Base projects with port health and PTY sessions. "
                "Use when the user asks what is running or which apps are configured."
            ),
            input_schema={
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        ),
        "homebase_project_status": CustomTool(
            execute=project_status_tool,
            description=(
                "Get one Home Base project's config, ports, sessions, and recent stack logs. "
                "Defaults to the active chat project."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "projectId": {
                        "type": "string",
                        "description": "Project id (default: active chat project)",
                    },
                    "logLines": {
                        "type": "integer",
                        "description": "Tail lines of stack log to include (default 40)",
                    },
                },
                "additionalProperties": False,
            },
        ),
        "homebase_run_action": CustomTool(
            execute=run_action_tool,
            description=(
                "Run a configured Home Base action (script/compose/stop/restart) for a project. "
                "actionId must match an action from the project config (e.g. run, stop, ship)."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "projectId": {"type": "string"},
                    "actionId": {
                        "type": "string",
                        "description": "Action id from the project config",
                    },
                    "extraArgs": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional extra CLI args appended to the action",
                    },
                },
                "required": ["actionId"],
                "additionalProperties": False,
            },
        ),
        "homebase_stop": CustomTool(
            execute=stop_tool,
            description=(
                "Stop a Home Base project: kill managed run/expo/ship/action PTYs, "
                "pidfile PIDs, and listeners on configured ports."
            ),
            input_schema={
                "type": "object",
                "properties": {"projectId": {"type": "string"}},
                "additionalProperties": False,
            },
        ),
        "homebase_logs": CustomTool(
            execute=logs_tool,
            description="Read the project's Home Base stack log tail.",
            input_schema={
                "type": "object",
                "properties": {
                    "projectId": {"type": "string"},
                    "lines": {"type": "integer", "description": "Lines to return (default 120)"},
                },
                "additionalProperties": False,
            },
        ),
        "homebase_sessions": CustomTool(
            execute=sessions_tool,
            description="List live Home Base PTY sessions (optionally filtered by projectId).",
            input_schema={
                "type": "object",
                "properties": {"projectId": {"type": "string"}},
                "additionalProperties": False,
            },
        ),
        "homebase_notify": CustomTool(
            execute=notify_tool,
            description=(
                "Push a toast/inbox notification into the Home Base UI "
                "(title, optional body, level: info|warn|error|success)."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "body": {"type": "string"},
                    "level": {
                        "type": "string",
                        "enum": ["info", "warn", "error", "success"],
                    },
                },
                "required": ["title"],
                "additionalProperties": False,
            },
        ),
        "homebase_inbox": CustomTool(
            execute=inbox_tool,
            description="Read recent Home Base notifications (newest first).",
            input_schema={
                "type": "object",
                "properties": {
                    "limit": {"type": "integer"},
                    "offset": {"type": "integer"},
                    "unreadOnly": {"type": "boolean"},
                },
                "additionalProperties": False,
            },
        ),
        "homebase_host_status": CustomTool(
            execute=host_status_tool,
            description=(
                "Home Base host status: version, bind address, homebased.service, "
                "WireGuard interfaces."
            ),
            input_schema={
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        ),
    }
    if readonly:
        allow = {
            "homebase_list_projects",
            "homebase_project_status",
            "homebase_logs",
            "homebase_sessions",
            "homebase_inbox",
            "homebase_host_status",
        }
        tools = {k: v for k, v in tools.items() if k in allow}
    return tools
