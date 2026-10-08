from __future__ import annotations

import asyncio
import os
import signal
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from ptyprocess import PtyProcessUnicode


@dataclass
class PtySession:
    id: str
    kind: str  # shell | run | ship | expo | action
    project_id: Optional[str]
    cwd: str
    cmdline: list[str]
    proc: PtyProcessUnicode
    created_at: float
    label: str = ""
    subscribers: set[Any] = field(default_factory=set)
    _reader_task: Optional[asyncio.Task] = None
    _closed: bool = False

    @property
    def pid(self) -> Optional[int]:
        try:
            return self.proc.pid
        except Exception:
            return None

    @property
    def alive(self) -> bool:
        try:
            return self.proc.isalive()
        except Exception:
            return False


class PtyManager:
    def __init__(self) -> None:
        self._sessions: dict[str, PtySession] = {}
        self._lock = asyncio.Lock()

    def list_sessions(self, project_id: Optional[str] = None) -> list[dict[str, Any]]:
        out = []
        for s in self._sessions.values():
            if project_id and s.project_id != project_id:
                continue
            out.append(self._public(s))
        return out

    def get(self, session_id: str) -> Optional[PtySession]:
        return self._sessions.get(session_id)

    def _public(self, s: PtySession) -> dict[str, Any]:
        return {
            "id": s.id,
            "kind": s.kind,
            "projectId": s.project_id,
            "cwd": s.cwd,
            "cmdline": s.cmdline,
            "label": s.label,
            "pid": s.pid,
            "alive": s.alive,
            "createdAt": s.created_at,
        }

    async def spawn(
        self,
        cmdline: list[str],
        *,
        cwd: str | Path,
        kind: str = "shell",
        project_id: Optional[str] = None,
        label: str = "",
        env: Optional[dict[str, str]] = None,
        cols: int = 120,
        rows: int = 40,
    ) -> PtySession:
        session_id = uuid.uuid4().hex[:12]
        cwd_s = str(cwd)
        full_env = os.environ.copy()
        if env:
            full_env.update(env)
        full_env.setdefault("TERM", "xterm-256color")
        full_env.setdefault("COLORTERM", "truecolor")

        proc = PtyProcessUnicode.spawn(
            cmdline,
            cwd=cwd_s,
            env=full_env,
            dimensions=(rows, cols),
        )
        session = PtySession(
            id=session_id,
            kind=kind,
            project_id=project_id,
            cwd=cwd_s,
            cmdline=cmdline,
            proc=proc,
            created_at=asyncio.get_event_loop().time(),
            label=label or " ".join(cmdline),
        )
        async with self._lock:
            self._sessions[session_id] = session
        session._reader_task = asyncio.create_task(self._read_loop(session))
        return session

    async def spawn_shell(
        self,
        *,
        cwd: str | Path,
        project_id: Optional[str] = None,
        cols: int = 120,
        rows: int = 40,
    ) -> PtySession:
        # Interactive non-login shell so cwd= sticks (login shells often jump to $HOME).
        shell = os.environ.get("SHELL", "/bin/bash")
        argv = [shell, "-i"] if "zsh" in shell or "bash" in shell else [shell]
        return await self.spawn(
            argv,
            cwd=cwd,
            kind="shell",
            project_id=project_id,
            label="shell",
            cols=cols,
            rows=rows,
        )

    async def _read_loop(self, session: PtySession) -> None:
        try:
            while session.alive and not session._closed:
                try:
                    data = await asyncio.to_thread(session.proc.read, 4096)
                except EOFError:
                    break
                except Exception:
                    break
                if not data:
                    await asyncio.sleep(0.02)
                    continue
                dead: list[Any] = []
                for ws in list(session.subscribers):
                    try:
                        await ws.send_json({"type": "output", "data": data})
                    except Exception:
                        dead.append(ws)
                for ws in dead:
                    session.subscribers.discard(ws)
        finally:
            session._closed = True
            for ws in list(session.subscribers):
                try:
                    await ws.send_json({"type": "exit", "sessionId": session.id})
                except Exception:
                    pass
            async with self._lock:
                # keep record briefly so clients can see exit; remove if no subscribers
                if session.id in self._sessions and not session.subscribers:
                    # leave for a bit — cleaned by kill or GC on stop
                    pass

    async def write(self, session_id: str, data: str) -> None:
        session = self._sessions.get(session_id)
        if not session or not session.alive:
            raise KeyError(session_id)
        await asyncio.to_thread(session.proc.write, data)

    async def resize(self, session_id: str, cols: int, rows: int) -> None:
        session = self._sessions.get(session_id)
        if not session or not session.alive:
            return
        try:
            await asyncio.to_thread(session.proc.setwinsize, rows, cols)
        except Exception:
            pass

    async def subscribe(self, session_id: str, websocket: Any) -> PtySession:
        session = self._sessions.get(session_id)
        if not session:
            raise KeyError(session_id)
        session.subscribers.add(websocket)
        return session

    def unsubscribe(self, session_id: str, websocket: Any) -> None:
        session = self._sessions.get(session_id)
        if session:
            session.subscribers.discard(websocket)

    def _kill_tree(self, pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError:
            try:
                os.kill(pid, signal.SIGTERM)
            except Exception:
                pass
        try:
            os.killpg(pid, signal.SIGKILL)
        except Exception:
            try:
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass

    async def kill(self, session_id: str) -> None:
        session = self._sessions.get(session_id)
        if not session:
            return
        session._closed = True
        pid = session.pid
        try:
            if session.alive:
                await asyncio.to_thread(session.proc.terminate, force=True)
        except Exception:
            pass
        if pid:
            await asyncio.to_thread(self._kill_tree, pid)
        if session._reader_task:
            session._reader_task.cancel()
        async with self._lock:
            self._sessions.pop(session_id, None)

    async def kill_by_project(
        self, project_id: str, kinds: Optional[set[str]] = None
    ) -> list[str]:
        killed = []
        for sid, s in list(self._sessions.items()):
            if s.project_id != project_id:
                continue
            if kinds and s.kind not in kinds:
                continue
            await self.kill(sid)
            killed.append(sid)
        return killed


pty_manager = PtyManager()
