from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .auth import lockout_status, require_auth, verify_token, ws_authenticate
from .config import BUNDLE_ROOT, ROOT, get_project, get_settings, list_projects, load_projects
from .cursor_bridge import cursor_bridge
from .files import list_dir, read_file, write_file
from .health import project_port_status
from .logging_util import append_daily, read_daily
from .notifications import clear_read, list_notifications, mark_read, push as notify
from .process_manager import list_projects_meta, stop_project, tail_logs, trigger_action
from .pty_manager import pty_manager

log = logging.getLogger("homebase")
logging.basicConfig(level=logging.INFO)

# SPA is bundled with the binary (Nuitka) or built under the repo.
WEB_DIST = BUNDLE_ROOT / "web" / "dist"
if not WEB_DIST.is_dir():
    WEB_DIST = ROOT / "web" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    load_projects(force=True)
    if not settings.token:
        log.warning("HOMEBASE_TOKEN is empty — all requests will fail auth")
    if not settings.cursor_api_key:
        log.warning("CURSOR_API_KEY is empty — Cursor chat disabled")
    n = len(list_projects())
    log.info("Loaded %d project(s) from config", n)
    yield
    await cursor_bridge.close()
    for s in list(pty_manager.list_sessions()):
        try:
            await pty_manager.kill(s["id"])
        except Exception:
            pass


app = FastAPI(title="Home Base", version="1.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ActionBody(BaseModel):
    actionId: str
    extraArgs: list[str] = Field(default_factory=list)


class WriteBody(BaseModel):
    path: str
    content: str


class LoginBody(BaseModel):
    token: str


class MarkReadBody(BaseModel):
    ids: list[str] = Field(default_factory=list)
    all: bool = False


@app.get("/api/health")
async def api_health():
    settings = get_settings()
    # Public: no lockout fail counts / project inventory (use /api/lockout + auth'd APIs).
    return {
        "ok": True,
        "tokenConfigured": bool(settings.token),
        "cursorConfigured": bool(settings.cursor_api_key),
        "model": settings.cursor_model,
    }


@app.post("/api/login")
async def api_login(body: LoginBody, request: Request):
    """Authenticate and reset lockout on success. Used by SPA login."""
    from .auth import _client_ip

    verify_token(body.token.strip(), ip=_client_ip(request=request))
    return {"ok": True, "lockout": lockout_status()}


@app.get("/api/lockout")
async def api_lockout():
    return lockout_status()


@app.get("/api/projects")
async def api_projects(_: None = Depends(require_auth)):
    load_projects(force=True)
    out = []
    for meta in list_projects_meta():
        try:
            project = get_project(meta["id"])
            ports = await project_port_status(project)
        except Exception:
            ports = []
        sessions = pty_manager.list_sessions(meta["id"])
        out.append(
            {
                **meta,
                "portsStatus": ports,
                "sessions": sessions,
                "cursor": cursor_bridge.agent_info(meta["id"]),
            }
        )
    return {"projects": out}


@app.get("/api/projects/{project_id}")
async def api_project(project_id: str, _: None = Depends(require_auth)):
    try:
        project = get_project(project_id)
    except KeyError:
        raise HTTPException(404, "Unknown project")
    meta = project.to_public()
    ports = await project_port_status(project)
    return {
        **meta,
        "portsStatus": ports,
        "sessions": pty_manager.list_sessions(project_id),
        "cursor": cursor_bridge.agent_info(project_id),
        "logs": tail_logs(project_id, 80),
    }


@app.post("/api/projects/{project_id}/action")
async def api_action(project_id: str, body: ActionBody, _: None = Depends(require_auth)):
    try:
        get_project(project_id)
    except KeyError:
        raise HTTPException(404, "Unknown project")
    try:
        result = await trigger_action(
            project_id, body.actionId, extra_args=body.extraArgs or None
        )
    except KeyError:
        raise HTTPException(404, f"Unknown action: {body.actionId}")
    except Exception as e:
        append_daily("action_error", projectId=project_id, actionId=body.actionId, error=str(e))
        notify(
            "Action failed",
            str(e),
            level="error",
            category="process",
            meta={"projectId": project_id, "actionId": body.actionId},
        )
        raise HTTPException(400, str(e))
    return result


@app.post("/api/projects/{project_id}/stop")
async def api_stop(project_id: str, _: None = Depends(require_auth)):
    try:
        get_project(project_id)
    except KeyError:
        raise HTTPException(404, "Unknown project")
    return await stop_project(project_id)


@app.get("/api/projects/{project_id}/logs")
async def api_logs(
    project_id: str, lines: int = 200, _: None = Depends(require_auth)
):
    try:
        get_project(project_id)
    except KeyError:
        raise HTTPException(404, "Unknown project")
    return tail_logs(project_id, lines)


@app.get("/api/projects/{project_id}/fs")
async def api_fs_list(
    project_id: str,
    path: str = "",
    _: None = Depends(require_auth),
):
    try:
        project = get_project(project_id)
    except KeyError:
        raise HTTPException(404, "Unknown project")
    try:
        return list_dir(project, path)
    except FileNotFoundError:
        raise HTTPException(404, "Not found")
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/api/projects/{project_id}/fs/read")
async def api_fs_read(
    project_id: str,
    path: str = Query(...),
    _: None = Depends(require_auth),
):
    try:
        project = get_project(project_id)
    except KeyError:
        raise HTTPException(404, "Unknown project")
    try:
        return read_file(project, path)
    except FileNotFoundError:
        raise HTTPException(404, "Not found")
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.put("/api/projects/{project_id}/fs/write")
async def api_fs_write(
    project_id: str, body: WriteBody, _: None = Depends(require_auth)
):
    try:
        project = get_project(project_id)
    except KeyError:
        raise HTTPException(404, "Unknown project")
    try:
        result = write_file(project, body.path, body.content)
        notify(
            "File saved",
            body.path,
            level="success",
            category="files",
            meta={"projectId": project_id, "path": body.path},
        )
        return result
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        append_daily("fs_write_error", projectId=project_id, path=body.path, error=str(e))
        raise HTTPException(400, str(e))


@app.get("/api/sessions")
async def api_sessions(
    project: Optional[str] = None, _: None = Depends(require_auth)
):
    return {"sessions": pty_manager.list_sessions(project)}


@app.delete("/api/sessions/{session_id}")
async def api_kill_session(session_id: str, _: None = Depends(require_auth)):
    await pty_manager.kill(session_id)
    return {"ok": True}


@app.get("/api/cursor/{project_id}")
async def api_cursor_info(project_id: str, _: None = Depends(require_auth)):
    try:
        get_project(project_id)
    except KeyError:
        raise HTTPException(404, "Unknown project")
    return cursor_bridge.agent_info(project_id)


@app.post("/api/cursor/{project_id}/reset")
async def api_cursor_reset(project_id: str, _: None = Depends(require_auth)):
    try:
        get_project(project_id)
    except KeyError:
        raise HTTPException(404, "Unknown project")
    await cursor_bridge.reset_agent(project_id)
    return {"ok": True}


@app.get("/api/notifications")
async def api_notifications(
    offset: int = 0,
    limit: int = 30,
    unreadOnly: bool = False,
    history: bool = False,
    _: None = Depends(require_auth),
):
    return list_notifications(
        offset=offset, limit=limit, unread_only=unreadOnly, history=history
    )


@app.post("/api/notifications/read")
async def api_notifications_read(body: MarkReadBody, _: None = Depends(require_auth)):
    count = mark_read(body.ids or None, all_read=body.all)
    return {"ok": True, "marked": count}


@app.delete("/api/notifications/read")
async def api_notifications_clear(_: None = Depends(require_auth)):
    return {"ok": True, "removed": clear_read()}


@app.get("/api/logs/daily")
async def api_daily_logs(
    day: Optional[str] = None,
    offset: int = 0,
    limit: int = 100,
    _: None = Depends(require_auth),
):
    return read_daily(day=day, limit=limit, offset=offset)


@app.websocket("/ws/pty")
async def ws_pty(websocket: WebSocket):
    if not await ws_authenticate(websocket):
        return
    await websocket.accept()
    project_id = websocket.query_params.get("project")
    cwd = websocket.query_params.get("cwd")
    cols = int(websocket.query_params.get("cols") or "100")
    rows = int(websocket.query_params.get("rows") or "32")

    # Shells must be scoped to a configured project (no free-form host cwd).
    if not project_id:
        await websocket.send_json({"type": "error", "error": "project required"})
        await websocket.close()
        return
    try:
        project = get_project(project_id)
    except KeyError:
        await websocket.send_json({"type": "error", "error": "Unknown project"})
        await websocket.close()
        return

    project_root = project.path.resolve()
    if cwd:
        try:
            requested = Path(cwd).expanduser().resolve()
            requested.relative_to(project_root)
            cwd = str(requested)
        except (ValueError, OSError):
            await websocket.send_json(
                {"type": "error", "error": "cwd must be inside the project directory"}
            )
            await websocket.close()
            return
    else:
        cwd = str(project_root)

    try:
        session = await pty_manager.spawn_shell(
            cwd=cwd, project_id=project_id, cols=cols, rows=rows
        )
    except Exception as e:
        await websocket.send_json({"type": "error", "error": str(e)})
        await websocket.close()
        return

    await pty_manager.subscribe(session.id, websocket)
    await websocket.send_json(
        {"type": "ready", "session": pty_manager._public(session)}
    )

    try:
        while True:
            msg = await websocket.receive_json()
            mtype = msg.get("type")
            if mtype == "input":
                await pty_manager.write(session.id, msg.get("data", ""))
            elif mtype == "resize":
                await pty_manager.resize(
                    session.id, int(msg.get("cols", cols)), int(msg.get("rows", rows))
                )
            elif mtype == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("pty ws error: %s", e)
    finally:
        pty_manager.unsubscribe(session.id, websocket)
        await pty_manager.kill(session.id)


@app.websocket("/ws/session/{session_id}")
async def ws_session(websocket: WebSocket, session_id: str):
    if not await ws_authenticate(websocket):
        return
    await websocket.accept()
    session = pty_manager.get(session_id)
    if not session:
        await websocket.send_json({"type": "error", "error": "Session not found"})
        await websocket.close()
        return

    await pty_manager.subscribe(session_id, websocket)
    await websocket.send_json(
        {"type": "ready", "session": pty_manager._public(session)}
    )
    try:
        while True:
            msg = await websocket.receive_json()
            mtype = msg.get("type")
            if mtype == "input":
                await pty_manager.write(session_id, msg.get("data", ""))
            elif mtype == "resize":
                await pty_manager.resize(
                    session_id, int(msg.get("cols", 100)), int(msg.get("rows", 32))
                )
            elif mtype == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        pty_manager.unsubscribe(session_id, websocket)


@app.websocket("/ws/cursor")
async def ws_cursor(websocket: WebSocket):
    if not await ws_authenticate(websocket):
        return
    await websocket.accept()
    project_id = websocket.query_params.get("project")
    if not project_id:
        await websocket.send_json({"type": "error", "error": "project required"})
        await websocket.close()
        return
    try:
        get_project(project_id)
    except KeyError:
        await websocket.send_json({"type": "error", "error": "Unknown project"})
        await websocket.close()
        return

    await websocket.send_json(
        {"type": "ready", "cursor": cursor_bridge.agent_info(project_id)}
    )

    try:
        while True:
            msg = await websocket.receive_json()
            mtype = msg.get("type")
            if mtype == "send":
                prompt = (msg.get("prompt") or "").strip()
                if not prompt:
                    continue
                async for event in cursor_bridge.send_stream(project_id, prompt):
                    await websocket.send_json(event)
            elif mtype == "cancel":
                ok = await cursor_bridge.cancel(project_id)
                await websocket.send_json({"type": "cancelled", "ok": ok})
            elif mtype == "reset":
                await cursor_bridge.reset_agent(project_id)
                await websocket.send_json(
                    {"type": "ready", "cursor": cursor_bridge.agent_info(project_id)}
                )
            elif mtype == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("cursor ws: %s", e)
        append_daily("cursor_error", projectId=project_id, error=str(e))
        try:
            await websocket.send_json({"type": "error", "error": str(e)})
        except Exception:
            pass


if WEB_DIST.is_dir():
    assets = WEB_DIST / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")


@app.get("/{full_path:path}")
async def spa(full_path: str):
    if full_path.startswith("api/") or full_path.startswith("ws/"):
        raise HTTPException(404)
    index = WEB_DIST / "index.html"
    if full_path and (WEB_DIST / full_path).is_file():
        return FileResponse(WEB_DIST / full_path)
    if index.is_file():
        return FileResponse(index)
    return {
        "message": "Home Base API is running. Run: ./build.sh --setup && ./build.sh --run",
        "docs": "/docs",
    }
