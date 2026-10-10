from __future__ import annotations

import asyncio
import os
import signal
import uuid
from dataclasses import dataclass, field
from pathlib import Path
import time
from typing import Any, Optional

from ptyprocess import PtyProcessUnicode

from .shell_env import enrich_shell_env, resolve_seat_user, seat_cmdline

# Late attach (Apps → Shell) needs recent output; keep a ring of chunks.
OUTPUT_BUFFER_MAX = 256_000
# After exit, keep the record briefly so clients can see the exit event.
_EXIT_GC_DELAY_SEC = 2.0


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
    output_buffer: list[str] = field(default_factory=list)
    output_bytes: int = 0
    _reader_task: Optional[asyncio.Task] = None
    _closed: bool = False

    def append_output(self, data: str) -> None:
        if not data:
            return
        self.output_buffer.append(data)
        self.output_bytes += len(data)
        while self.output_bytes > OUTPUT_BUFFER_MAX and self.output_buffer:
            dropped = self.output_buffer.pop(0)
            self.output_bytes -= len(dropped)

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
        # Native seat-user env (login+interactive profile) + caller overrides.
        # Under systemd root, wrap with setpriv so Expo/run match a laptop shell.
        full_env = enrich_shell_env(env)
        try:
            from .sudo_auth import askpass_env

            for k, v in askpass_env().items():
                full_env.setdefault(k, v)
        except Exception:
            pass
        full_env.setdefault("TERM", "xterm-256color")
        full_env.setdefault("COLORTERM", "truecolor")

        spawn_argv = seat_cmdline(list(cmdline))
        proc = PtyProcessUnicode.spawn(
            spawn_argv,
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
            created_at=time.monotonic(),
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
        # Env already includes the seat user's login+interactive profile.
        seat = resolve_seat_user()
        shell = (seat.shell if seat else None) or os.environ.get("SHELL", "/bin/bash")
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
                session.append_output(data)
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
            asyncio.create_task(self._gc_after_exit(session))

    async def _gc_after_exit(self, session: PtySession) -> None:
        """Drop exited sessions once clients have had a chance to observe exit."""
        try:
            await asyncio.sleep(_EXIT_GC_DELAY_SEC)
        except asyncio.CancelledError:
            return
        async with self._lock:
            current = self._sessions.get(session.id)
            if current is session and current._closed and not current.subscribers:
                self._sessions.pop(session.id, None)

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
        # Replay buffered output so Apps→Shell attach isn't a blank screen
        if session.output_buffer:
            replay = "".join(session.output_buffer)
            try:
                await websocket.send_json({"type": "output", "data": replay})
            except Exception:
                pass
        return session

    def unsubscribe(self, session_id: str, websocket: Any) -> None:
        session = self._sessions.get(session_id)
        if not session:
            return
        session.subscribers.discard(websocket)
        if session._closed and not session.subscribers:
            self._sessions.pop(session_id, None)

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

    def output_tail(
        self,
        project_id: str,
        *,
        kinds: Optional[set[str]] = None,
        lines: int = 200,
    ) -> str:
        """Joined PTY ring buffers for a project (Run+Expo compose Logs fallback)."""
        chunks: list[str] = []
        for s in self._sessions.values():
            if s.project_id != project_id:
                continue
            if kinds and s.kind not in kinds:
                continue
            if not s.output_buffer:
                continue
            header = s.label or s.id
            chunks.append(f"--- {s.kind}: {header} ---\n")
            chunks.append("".join(s.output_buffer))
            if not chunks[-1].endswith("\n"):
                chunks.append("\n")
        if not chunks:
            return ""
        text = "".join(chunks)
        return "\n".join(text.splitlines()[-max(1, lines):])


pty_manager = PtyManager()
