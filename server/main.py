from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from starlette.middleware.gzip import GZipMiddleware

from .auth import (
    _client_ip,
    auth_public_status,
    bootstrap_password,
    change_password,
    jwt_secret,
    lockout_status,
    login_with_password,
    password_is_set,
    require_auth,
    ws_authenticate,
)
from .config import BUNDLE_ROOT, ROOT, get_project, get_settings, list_projects, load_projects
from .cursor_bridge import cursor_bridge
from .files import list_dir, read_file, write_file
from .health import project_port_status
from .logging_util import append_daily, read_daily
from .notifications import clear_read, list_notifications, mark_read, push as notify
from .process_manager import list_projects_meta, stop_project, tail_logs, trigger_action
from .pty_manager import pty_manager
from .share import (
    hide as share_hide,
    mdns_hostname,
    redeem as share_redeem,
    require_localhost_browser,
    reveal as share_reveal,
    status as share_status,
)
from .static_compress import compressed_file_response
from .system_ctl import list_wireguard, restart_homebased, restart_wireguard
from .trace_log import install_logging_handler, snapshot as trace_snapshot
from .trace_log import append as trace_append
from .version import read_version, running_as_backup, status_payload as version_status
from .view import view_hub

log = logging.getLogger("homebase")
logging.basicConfig(level=logging.INFO)
install_logging_handler()

# SPA is bundled with the binary (Nuitka) or built under the repo.
WEB_DIST = BUNDLE_ROOT / "web" / "dist"
if not WEB_DIST.is_dir():
    WEB_DIST = ROOT / "web" / "dist"

APP_VERSION = read_version()


@asynccontextmanager
async def lifespan(app: FastAPI):
    from .cursor_env import ensure_cursor_bridge_env

    settings = get_settings()
    load_projects(force=True)
    jwt_secret()  # ensure signing key exists
    bridge = ensure_cursor_bridge_env()
    if settings.cursor_api_key and not bridge:
        log.warning(
            "CURSOR_API_KEY set but cursor-sdk-bridge missing — "
            "run ./build.sh --service to install the bridge under /usr/share/homebased"
        )
    if not password_is_set():
        log.warning("No password set — open the UI on localhost to create one")
    if not settings.cursor_api_key:
        log.warning("CURSOR_API_KEY is empty — Cursor chat disabled")
    if running_as_backup():
        log.error("Running BACKUP binary after failed deploy — check last --deploy")
        notify(
            "Running backup build",
            f"v{APP_VERSION} — last deploy failed self-test; fix and redeploy",
            level="warn",
            category="system",
        )
    n = len(list_projects())
    log.info("Loaded %d project(s) from config (v%s)", n, APP_VERSION)
    trace_append("info", f"startup: {n} project(s) v{APP_VERSION}", source="server")
    yield
    await cursor_bridge.close()
    for s in list(pty_manager.list_sessions()):
        try:
            await pty_manager.kill(s["id"])
        except Exception:
            pass
    try:
        view_hub.shutdown()
    except Exception:
        pass
    trace_append("info", "shutdown", source="server")


app = FastAPI(title="Home Base", version=APP_VERSION, lifespan=lifespan)
# Same-origin SPA only (Vite proxies /api+/ws in dev; FastAPI serves both in prod).
# No open CORS — the browser never needs cross-origin API access.
# On-the-fly gzip for API JSON / HTML when no precompressed body is set
app.add_middleware(GZipMiddleware, minimum_size=500)


class ActionBody(BaseModel):
    actionId: str
    extraArgs: list[str] = Field(default_factory=list)


class WriteBody(BaseModel):
    path: str
    content: str


class LoginBody(BaseModel):
    password: str = ""


class PasswordBody(BaseModel):
    password: str
    currentPassword: Optional[str] = None


class ShareRevealBody(BaseModel):
    port: int = 3081
    protocol: str = "http"


class ShareRedeemBody(BaseModel):
    shareId: str


class MarkReadBody(BaseModel):
    ids: list[str] = Field(default_factory=list)
    all: bool = False


@app.get("/api/health")
async def api_health():
    settings = get_settings()
    status = auth_public_status()
    ver = version_status()
    return {
        "ok": True,
        "passwordSet": status["passwordSet"],
        "tokenConfigured": status["passwordSet"],  # compat
        "cursorConfigured": bool(settings.cursor_api_key),
        "model": settings.cursor_model,
        "jwtTtlSec": status["jwtTtlSec"],
        "version": ver["version"],
        "backup": ver["backup"],
    }


@app.get("/api/version")
async def api_version():
    return version_status()


@app.get("/api/system/status")
async def api_system_status(_: None = Depends(require_auth)):
    wg = list_wireguard()
    return {
        "wireguard": wg,
        "homebasedUnit": "homebased.service",
        **version_status(),
    }


@app.post("/api/system/restart/homebased")
async def api_restart_homebased(_: None = Depends(require_auth)):
    try:
        result = await restart_homebased()
    except Exception as e:
        raise HTTPException(500, str(e)) from e
    append_daily("system_restart", target="homebased", ok=result.get("ok"))
    notify(
        "Home Base restart",
        "Service restart requested",
        level="info" if result.get("ok") else "warn",
        category="system",
    )
    return result


class WgRestartBody(BaseModel):
    iface: Optional[str] = None


@app.post("/api/system/restart/wireguard")
async def api_restart_wireguard(
    body: WgRestartBody = WgRestartBody(), _: None = Depends(require_auth)
):
    try:
        result = await restart_wireguard(body.iface)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    except Exception as e:
        raise HTTPException(500, str(e)) from e
    append_daily("system_restart", target="wireguard", ok=result.get("ok"), iface=body.iface)
    notify(
        "VPN restart",
        f"WireGuard restart ({body.iface or 'all'})",
        level="info" if result.get("ok") else "warn",
        category="system",
    )
    return result


@app.get("/api/auth/status")
async def api_auth_status():
    return auth_public_status()


@app.post("/api/login")
async def api_login(body: LoginBody, request: Request):
    """Password → 24h JWT session."""
    issued = login_with_password(
        body.password.strip(), ip=_client_ip(request=request)
    )
    return {"ok": True, "lockout": lockout_status(), **issued}


@app.post("/api/auth/bootstrap")
async def api_bootstrap_password(body: PasswordBody, request: Request):
    """
    First-time password create from the login page (localhost only).
    Refuses once `initialized` is set — even if the hash file is wiped without
    clearing the flag; both flag and hash must be gone to bootstrap again.
    """
    require_localhost_browser(request)
    bootstrap_password(body.password)
    issued = login_with_password(
        body.password.strip(), ip=_client_ip(request=request)
    )
    return {"ok": True, "passwordSet": True, "initialized": True, **issued}


@app.post("/api/auth/password")
async def api_change_password(
    body: PasswordBody, request: Request, _: None = Depends(require_auth)
):
    """Change password from Share tab (localhost + current password). Not the login route."""
    require_localhost_browser(request)
    if not body.currentPassword:
        raise HTTPException(400, "Current password is required")
    change_password(body.password, body.currentPassword)
    issued = login_with_password(
        body.password.strip(), ip=_client_ip(request=request)
    )
    return {"ok": True, "passwordSet": True, **issued}


@app.get("/api/lockout")
async def api_lockout():
    return lockout_status()


@app.get("/api/share/status")
async def api_share_status(request: Request, _: None = Depends(require_auth)):
    require_localhost_browser(request)
    return share_status()


@app.post("/api/share/reveal")
async def api_share_reveal(
    body: ShareRevealBody, request: Request, _: None = Depends(require_auth)
):
    require_localhost_browser(request)
    return share_reveal(port=body.port, protocol=body.protocol)


@app.post("/api/share/hide")
async def api_share_hide(request: Request, _: None = Depends(require_auth)):
    require_localhost_browser(request)
    return share_hide()


@app.post("/api/share/redeem")
async def api_share_redeem(body: ShareRedeemBody):
    """Public: exchange a one-time share id for a 24h session JWT."""
    return {"ok": True, **share_redeem(body.shareId)}


@app.get("/api/share/hostname")
async def api_share_hostname(request: Request, _: None = Depends(require_auth)):
    require_localhost_browser(request)
    return {"hostname": mdns_hostname()}


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
    all: bool = Query(False, description="Include skipped dirs (node_modules, .git, …)"),
    _: None = Depends(require_auth),
):
    try:
        project = get_project(project_id)
    except KeyError:
        raise HTTPException(404, "Unknown project")
    try:
        return list_dir(project, path, include_ignored=bool(all))
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


@app.post("/api/sessions/{session_id}/interrupt")
async def api_interrupt_session(session_id: str, _: None = Depends(require_auth)):
    """Send Ctrl+C twice (SIGINT) to the session PTY — does not kill the session."""
    session = pty_manager.get(session_id)
    if not session or not session.alive:
        raise HTTPException(404, "Session not found")
    try:
        await pty_manager.write(session_id, "\x03")
        await asyncio.sleep(0.05)
        await pty_manager.write(session_id, "\x03")
    except KeyError:
        raise HTTPException(404, "Session not found") from None
    return {"ok": True}


@app.get("/api/cursor/models")
async def api_cursor_models(_: None = Depends(require_auth)):
    return await cursor_bridge.list_models()


@app.get("/api/cursor/{project_id}")
async def api_cursor_info(
    project_id: str,
    chatId: str = "default",
    _: None = Depends(require_auth),
):
    try:
        get_project(project_id)
    except KeyError:
        raise HTTPException(404, "Unknown project")
    return cursor_bridge.agent_info(project_id, chat_id=chatId)


@app.post("/api/cursor/{project_id}/reset")
async def api_cursor_reset(
    project_id: str,
    chatId: str = "default",
    _: None = Depends(require_auth),
):
    try:
        get_project(project_id)
    except KeyError:
        raise HTTPException(404, "Unknown project")
    await cursor_bridge.reset_agent(project_id, chat_id=chatId)
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


@app.get("/api/trace")
async def api_trace(
    limit: int = 300,
    afterId: int = 0,
    _: None = Depends(require_auth),
):
    """In-memory server console ring (max 300). No disk growth."""
    return trace_snapshot(limit=limit, after_id=afterId)


@app.post("/api/trace/client")
async def api_trace_client(request: Request, _: None = Depends(require_auth)):
    """Accept a small batch of browser console lines into the same ring."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "invalid json")
    lines = body.get("lines") if isinstance(body, dict) else None
    if not isinstance(lines, list):
        raise HTTPException(400, "lines required")
    accepted = 0
    for raw in lines[:50]:
        if not isinstance(raw, dict):
            continue
        msg = str(raw.get("message") or "")[:2000]
        if not msg:
            continue
        level = str(raw.get("level") or "info")[:16]
        trace_append(level, msg, source="web")
        accepted += 1
    return {"ok": True, "accepted": accepted}


@app.get("/api/view/status")
def api_view_status(_: None = Depends(require_auth)):
    """Probe whether screen capture/input is available (JWT)."""
    return view_hub.status()


@app.websocket("/ws/view")
async def ws_view(websocket: WebSocket):
    """Remote desktop stream + input. JWT required. Capture runs only while connected."""
    if not await ws_authenticate(websocket):
        return
    await websocket.accept()
    client = None
    try:
        client = await view_hub.connect(websocket)
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if "text" in message and message["text"] is not None:
                try:
                    msg = json.loads(message["text"])
                except json.JSONDecodeError:
                    continue
                if isinstance(msg, dict):
                    await view_hub.handle_message(client, msg)
            # Binary client→server unused (frames are server→client only)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("view ws: %s", e)
        try:
            await websocket.send_json({"type": "error", "error": str(e)})
        except Exception:
            pass
    finally:
        if client is not None:
            await view_hub.disconnect(websocket)


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
                try:
                    await pty_manager.write(session.id, msg.get("data", ""))
                except KeyError:
                    await websocket.send_json({"type": "exit", "sessionId": session.id})
                    break
            elif mtype == "resize":
                try:
                    c = max(2, int(msg.get("cols") or cols))
                    r = max(2, int(msg.get("rows") or rows))
                except (TypeError, ValueError):
                    continue
                await pty_manager.resize(session.id, c, r)
            elif mtype == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("pty ws error: %s", e)
    finally:
        # Detach only — keep the PTY alive until Kill / process exit.
        pty_manager.unsubscribe(session.id, websocket)


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
                try:
                    await pty_manager.write(session_id, msg.get("data", ""))
                except KeyError:
                    await websocket.send_json({"type": "exit", "sessionId": session_id})
                    break
            elif mtype == "resize":
                try:
                    c = max(2, int(msg.get("cols") or 100))
                    r = max(2, int(msg.get("rows") or 32))
                except (TypeError, ValueError):
                    continue
                await pty_manager.resize(session_id, c, r)
            elif mtype == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("session ws error: %s", e)
    finally:
        pty_manager.unsubscribe(session_id, websocket)


@app.websocket("/ws/cursor")
async def ws_cursor(websocket: WebSocket):
    """One connection per project; client sends bind/send with chatId (no reconnect per tab)."""
    if not await ws_authenticate(websocket):
        return
    await websocket.accept()
    project_id = websocket.query_params.get("project")
    chat_id = (websocket.query_params.get("chat") or "default").strip() or "default"
    cwd = (websocket.query_params.get("cwd") or "").strip()
    if not project_id:
        await websocket.send_json({"type": "error", "error": "project required"})
        await websocket.close(code=1008)
        return
    try:
        get_project(project_id)
    except KeyError:
        await websocket.send_json({"type": "error", "error": "Unknown project"})
        await websocket.close(code=1008)
        return

    await websocket.send_json(
        {
            "type": "ready",
            "cursor": cursor_bridge.agent_info(project_id, chat_id=chat_id),
            "chatId": chat_id,
            "cwd": cwd,
        }
    )

    try:
        while True:
            msg = await websocket.receive_json()
            mtype = msg.get("type")
            if mtype == "bind":
                chat_id = (msg.get("chatId") or msg.get("chat") or "default").strip() or "default"
                cwd = (msg.get("cwd") or "").strip()
                await websocket.send_json(
                    {
                        "type": "ready",
                        "cursor": cursor_bridge.agent_info(
                            project_id, chat_id=chat_id
                        ),
                        "chatId": chat_id,
                        "cwd": cwd,
                    }
                )
            elif mtype == "send":
                prompt = (msg.get("prompt") or "").strip()
                if not prompt:
                    continue
                model = (msg.get("model") or "").strip() or None
                send_chat = (
                    (msg.get("chatId") or msg.get("chat") or chat_id).strip()
                    or "default"
                )
                send_cwd = (msg.get("cwd") or cwd or "").strip() or None
                chat_id = send_chat
                if send_cwd is not None:
                    cwd = send_cwd
                async for event in cursor_bridge.send_stream(
                    project_id,
                    prompt,
                    model=model,
                    chat_id=send_chat,
                    cwd=send_cwd,
                ):
                    await websocket.send_json(event)
                    # Yield so other WS traffic (cancel/ping) can interleave mid-stream
                    await asyncio.sleep(0)
            elif mtype == "cancel":
                cancel_chat = (
                    (msg.get("chatId") or msg.get("chat") or chat_id).strip()
                    or "default"
                )
                ok = await cursor_bridge.cancel(project_id, chat_id=cancel_chat)
                await websocket.send_json({"type": "cancelled", "ok": ok})
            elif mtype == "reset":
                reset_chat = (
                    (msg.get("chatId") or msg.get("chat") or chat_id).strip()
                    or "default"
                )
                await cursor_bridge.reset_agent(project_id, chat_id=reset_chat)
                await websocket.send_json(
                    {
                        "type": "ready",
                        "cursor": cursor_bridge.agent_info(
                            project_id, chat_id=reset_chat
                        ),
                        "chatId": reset_chat,
                    }
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


@app.get("/assets/{asset_path:path}")
async def spa_assets(asset_path: str, request: Request):
    """Serve hashed Vite assets, preferring build-time .br / .gz."""
    root = (WEB_DIST / "assets").resolve()
    target = (root / asset_path).resolve()
    if not str(target).startswith(str(root)) or not target.is_file():
        raise HTTPException(404)
    if target.suffix in {".br", ".gz"}:
        raise HTTPException(404)
    return compressed_file_response(target, request)


@app.get("/{full_path:path}")
async def spa(full_path: str, request: Request):
    if full_path.startswith("api/") or full_path.startswith("ws/"):
        raise HTTPException(404)
    index = WEB_DIST / "index.html"
    if full_path:
        candidate = (WEB_DIST / full_path).resolve()
        root = WEB_DIST.resolve()
        if (
            str(candidate).startswith(str(root))
            and candidate.is_file()
            and candidate.suffix not in {".br", ".gz"}
        ):
            return compressed_file_response(candidate, request)
    if index.is_file():
        return compressed_file_response(index, request)
    return {
        "message": "Home Base API is running. Run: ./build.sh --setup && ./build.sh --run",
        "docs": "/docs",
    }
