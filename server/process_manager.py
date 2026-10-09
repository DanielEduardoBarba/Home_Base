from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any, Optional

from .config import SESSIONS_PATH, ActionDef, Project, get_project, list_projects
from .network import project_lan_env
from .notifications import push as notify
from .ports import kill_pids, kill_ports
from .pty_manager import pty_manager
from .shell_env import resolve_seat_user
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


def _chown_tree(path: Path, uid: int, gid: int) -> None:
    """Best-effort chown so seat-user PTYs can write stateDir/tmp caches."""
    try:
        os.chown(path, uid, gid)
    except OSError:
        return
    if not path.is_dir():
        return
    try:
        entries = list(path.iterdir())
    except OSError:
        return
    for child in entries:
        try:
            if child.is_symlink():
                continue
            if child.is_dir():
                _chown_tree(child, uid, gid)
            else:
                os.chown(child, uid, gid)
        except OSError:
            continue


def ensure_project_state_writable(project: Project) -> None:
    """Create stateDir/tmp and chown to seat user when homebased is root.

    Older root PTYs left root-owned caches; seat-user Next/Expo then hit EACCES.
    """
    if not project.state_dir:
        return
    state = project.path / project.state_dir
    tmp = state / "tmp"
    try:
        state.mkdir(parents=True, exist_ok=True)
        tmp.mkdir(parents=True, exist_ok=True)
    except OSError:
        return

    seat = resolve_seat_user()
    if not seat or os.geteuid() != 0:
        return
    _chown_tree(state, seat.uid, seat.gid)


async def _wait_for_compose_gate(
    project: Project,
    *,
    timeout: float = 75.0,
) -> dict[str, Any]:
    """After a run-kind compose step, wait for API (or first non-expo port) before Expo."""
    from .health import check_port

    prefer = [p for p in project.ports if p.id == "api"]
    if not prefer:
        prefer = [p for p in project.ports if p.id != "expo"][:1]
    if not prefer:
        return {"ready": True, "ports": [], "waited": False}

    deadline = time.monotonic() + timeout
    last: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        last = [await check_port(project, p.id) for p in prefer]
        ready = True
        for row in last:
            if not row.get("up"):
                ready = False
                break
            health = row.get("health")
            if isinstance(health, dict) and health.get("ok") is False:
                ready = False
                break
        if ready:
            return {"ready": True, "ports": last, "waited": True}
        await asyncio.sleep(1.0)
    return {"ready": False, "ports": last, "waited": True}


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
        # e.g. Run + Expo → two PTYs (./build.sh --run and --run --expo).
        # Start run first, wait for API health, then Expo so Metro is not racing a cold API.
        ids = list(action.compose)
        if not ids:
            raise ValueError(f"Action {action.id} type=compose needs compose: [actionId, …]")
        await asyncio.to_thread(ensure_project_state_writable, project)
        sessions: list[dict[str, Any]] = []
        gate: dict[str, Any] | None = None
        for i, aid in enumerate(ids):
            target = project.action(aid)
            if target.type == "compose":
                raise ValueError("Nested compose actions are not supported")
            result = await run_action_def(project_id, target)
            if result.get("type") == "session" and result.get("session"):
                sessions.append(result["session"])
            # Gate Expo (and later steps) on the run stack being reachable.
            if target.kind == "run" and i < len(ids) - 1:
                gate = await _wait_for_compose_gate(project)
                if not gate.get("ready"):
                    notify(
                        f"{project.name}: {action.label}",
                        "Run started but API not healthy yet — starting Expo anyway",
                        level="warn",
                        category="process",
                        meta={
                            "projectId": project_id,
                            "actionId": action.id,
                            "gate": gate,
                        },
                    )
        # Summary after both PTYs exist (spawn toasts already fired per child).
        from .health import project_port_status

        ports = await project_port_status(project)
        up = [p["id"] for p in ports if p.get("up")]
        down = [p["id"] for p in ports if not p.get("up")]
        level = "success" if not down else ("warn" if up else "error")
        body = f"up={','.join(up) or 'none'}"
        if down:
            body += f" down={','.join(down)}"
        notify(
            f"{project.name}: {action.label}",
            body,
            level=level,
            category="process",
            meta={
                "projectId": project_id,
                "actionId": action.id,
                "sessions": [s.get("id") for s in sessions],
                "ports": ports,
                "gate": gate,
            },
        )
        return {"type": "sessions", "sessions": sessions, "ports": ports, "gate": gate}

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

    await asyncio.to_thread(ensure_project_state_writable, project)

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
    """Prefer stateDir/stack.log; fall back to live run/expo PTY rings when empty.

    Plain `./build.sh --run` (Home Base compose) historically left stack.log blank —
    real output lives in the PTY buffer until the project tees into the file.
    """
    project = get_project(project_id)
    path = project.stack_log
    file_text = ""
    exists = path.is_file()
    if exists:
        try:
            content = path.read_text(errors="replace").splitlines()
            file_text = "\n".join(content[-lines:])
        except OSError as e:
            return {"path": str(path), "exists": True, "text": "", "error": str(e)}

    if file_text.strip():
        return {"path": str(path), "exists": exists, "text": file_text, "source": "file"}

    pty_text = pty_manager.output_tail(
        project_id,
        kinds={"run", "expo", "ship", "action"},
        lines=lines,
    )
    if pty_text.strip():
        return {
            "path": str(path),
            "exists": exists,
            "text": pty_text,
            "source": "pty",
        }
    return {"path": str(path), "exists": exists, "text": "", "source": "empty"}


def list_projects_meta() -> list[dict[str, Any]]:
    return [p.to_public() for p in list_projects()]
