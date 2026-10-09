from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Optional

from .config import SESSIONS_PATH, ActionDef, Project, get_project, list_projects
from .network import project_lan_env
from .notifications import push as notify
from .ports import kill_pids, kill_ports
from .pty_manager import pty_manager
from .trace_log import append as trace


def _persist() -> None:
    payload = {"sessions": pty_manager.list_sessions()}
    SESSIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SESSIONS_PATH.write_text(json.dumps(payload, indent=2))


def _stop_pidfile(project: Project) -> list[int]:
    stopped: list[int] = []
    pid_file = project.pid_file
    if not pid_file.is_file():
        return stopped
    try:
        lines = pid_file.read_text().splitlines()
    except OSError:
        return stopped
    pids: list[int] = []
    for line in lines:
        line = line.strip()
        if line.isdigit():
            pids.append(int(line))
    stopped = kill_pids(pids)
    try:
        pid_file.unlink(missing_ok=True)
    except OSError:
        pass
    return stopped


def _stop_by_ports(project: Project) -> list[int]:
    """Kill listeners on configured ports (covers stacks started outside Home Base)."""
    ports = [p.port for p in project.ports]
    if not ports:
        return []
    return kill_ports(ports)


def _resolve_script(project: Project, script: str) -> Path:
    # Allow ./build.sh or absolute paths under project
    if script.startswith("./") or not script.startswith("/"):
        path = (project.path / script).resolve()
    else:
        path = Path(script).resolve()
    try:
        path.relative_to(project.path.resolve())
    except ValueError as e:
        raise PermissionError("Script must live inside the project directory") from e
    if not path.is_file():
        raise FileNotFoundError(f"Missing script: {script}")
    return path


async def stop_project(project_id: str) -> dict[str, Any]:
    project = get_project(project_id)
    # Keep interactive Shell-tab PTYs; stop managed run/ship/action sessions.
    killed = await pty_manager.kill_by_project(
        project_id, kinds={"run", "expo", "ship", "action"}
    )
    extra = await asyncio.to_thread(_stop_pidfile, project)
    # Always free configured ports so Stop works even when nothing was started via PTY.
    port_killed = await asyncio.to_thread(_stop_by_ports, project)
    _persist()
    msg = (
        f"sessions={len(killed)} pidfile={len(extra)} ports={len(port_killed)}"
    )
    trace("info", f"stop {project.id}: {msg}", projectId=project_id)
    notify(
        f"Stopped {project.name}",
        msg,
        level="info",
        category="process",
        meta={
            "projectId": project_id,
            "killed": killed,
            "pidFileStopped": extra,
            "portStopped": port_killed,
        },
    )
    return {
        "killedSessions": killed,
        "pidFileStopped": extra,
        "portStopped": port_killed,
    }


async def run_action_def(
    project_id: str,
    action: ActionDef,
    *,
    extra_args: Optional[list[str]] = None,
) -> dict[str, Any]:
    project = get_project(project_id)

    if action.type == "stop":
        return {"type": "stop", **(await stop_project(project_id))}

    if action.type == "restart":
        await stop_project(project_id)
        target_id = action.restart_action or "run"
        target = project.action(target_id)
        return await run_action_def(project_id, target)

    if action.type == "compose":
        # e.g. Run + Expo → two PTYs (./build.sh --run and --run --expo)
        ids = list(action.compose)
        if not ids:
            raise ValueError(f"Action {action.id} type=compose needs compose: [actionId, …]")
        sessions: list[dict[str, Any]] = []
        for aid in ids:
            target = project.action(aid)
            if target.type == "compose":
                raise ValueError("Nested compose actions are not supported")
            result = await run_action_def(project_id, target)
            if result.get("type") == "session" and result.get("session"):
                sessions.append(result["session"])
        return {"type": "sessions", "sessions": sessions}

    if action.type != "script" and action.type not in {"", "script"}:
        # treat unknown with script as script
        if not action.script:
            raise ValueError(f"Unsupported action type: {action.type}")

    if not action.script:
        raise ValueError(f"Action {action.id} has no script")

    script_path = _resolve_script(project, action.script)
    args = list(action.args) + list(extra_args or [])
    cmdline = ["bash", str(script_path), *args]

    kind = action.kind if action.kind in {"run", "expo", "ship", "action"} else "action"
    # Replace prior sessions of same kind for run/expo to avoid duplicates
    if kind in {"run", "expo"}:
        await pty_manager.kill_by_project(project_id, kinds={kind})

    # VPN/LAN: inject advertise host so Expo Metro + NEXT/EXPO API URLs are reachable
    # off-localhost (WireGuard preferred). Action env wins on key conflicts.
    env: dict[str, str] = {}
    if kind in {"run", "expo"}:
        env.update(
            project_lan_env([(p.id, p.port) for p in project.ports])
        )
    if action.env:
        env.update(dict(action.env))
    session = await pty_manager.spawn(
        cmdline,
        cwd=project.path,
        kind=kind,
        project_id=project_id,
        label=f"{action.label}: {' '.join([action.script, *args])}",
        env=env or None,
    )
    _persist()
    trace(
        "info",
        f"action {action.id} → session {session.id}",
        projectId=project_id,
        actionId=action.id,
    )
    notify(
        f"{project.name}: {action.label}",
        session.label,
        level="success",
        category="process",
        meta={"projectId": project_id, "sessionId": session.id, "actionId": action.id},
    )
    return {"type": "session", "session": pty_manager._public(session)}


async def trigger_action(
    project_id: str,
    action_id: str,
    *,
    extra_args: Optional[list[str]] = None,
) -> dict[str, Any]:
    project = get_project(project_id)
    action = project.action(action_id)
    return await run_action_def(project_id, action, extra_args=extra_args)


def tail_logs(project_id: str, lines: int = 200) -> dict[str, Any]:
    project = get_project(project_id)
    path = project.stack_log
    if not path.is_file():
        return {"path": str(path), "exists": False, "text": ""}
    try:
        content = path.read_text(errors="replace").splitlines()
        text = "\n".join(content[-lines:])
    except OSError as e:
        return {"path": str(path), "exists": True, "text": "", "error": str(e)}
    return {"path": str(path), "exists": True, "text": text}


def list_projects_meta() -> list[dict[str, Any]]:
    return [p.to_public() for p in list_projects()]
