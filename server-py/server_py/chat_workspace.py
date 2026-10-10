"""One chat workspace per project, shared by every browser.

The agent run lives here, not on a WebSocket. Browsers subscribe to watch.
Closing a tab unsubscribes that browser and leaves the run going.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import re
import secrets
import time
from typing import Any, Optional

from .chat_text import append_stream_chunk, collapse_doubled_tokens, merge_assistant_text
from .config import RUNTIME_DIR
from .cursor_bridge import cursor_bridge

log = logging.getLogger("homebase.chat")

CHATS_DIR = RUNTIME_DIR / "chats"
MAX_TABS = 40
MAX_MESSAGES = 200
MAX_TEXT = 24_000
# How often a live reply is pushed to browsers while tokens arrive.
PUSH_INTERVAL_SEC = 0.08

_ID_OK = re.compile(r"^[A-Za-z0-9_-]{4,64}$")
_REAL_ROLES = frozenset({"user", "assistant", "thinking", "tool", "file"})


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id() -> str:
    return secrets.token_hex(5)


def _clip(text: str) -> str:
    if len(text) <= MAX_TEXT:
        return text
    return text[-MAX_TEXT:]


def _session_key(project_id: str, chat_id: str) -> str:
    cid = (chat_id or "default").strip() or "default"
    return f"{project_id}:{cid}"


def _safe_name(project_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", project_id)[:80] or "project"


class ChatWorkspace:
    def __init__(self) -> None:
        # project id → {activeId, tabs}
        self._projects: dict[str, dict[str, Any]] = {}
        self._subs: dict[str, set[Any]] = {}
        # "project:chat" → background task that owns the Cursor run
        self._tasks: dict[str, asyncio.Task[None]] = {}
        # Bumped to tell a run "someone reset you; do not write the transcript".
        self._generation: dict[str, int] = {}
        # True after a text-delta this turn, so a final snapshot can replace.
        self._saw_deltas: dict[str, bool] = {}
        self._last_push: dict[str, float] = {}
        self._save_tasks: dict[str, asyncio.Task[None]] = {}
        # Chats the user asked to stop; the note is written when the run ends.
        self._stop_notes: set[str] = set()

    # --- disk -----------------------------------------------------------------

    def _path(self, project_id: str):
        return CHATS_DIR / f"{_safe_name(project_id)}.json"

    def _load(self, project_id: str) -> dict[str, Any]:
        path = self._path(project_id)
        if path.is_file():
            try:
                raw = json.loads(path.read_text())
                state = self._normalize(raw)
                self._heal_restart(state)
                return state
            except Exception as e:
                log.warning("chat load %s failed: %s", project_id, e)
        tab = self._blank_tab()
        return {"activeId": tab["id"], "tabs": [tab]}

    def _normalize(self, raw: Any) -> dict[str, Any]:
        tabs_in = raw.get("tabs") if isinstance(raw, dict) else None
        tabs = []
        if isinstance(tabs_in, list):
            for item in tabs_in[:MAX_TABS]:
                tab = self._sanitize_tab(item)
                if tab:
                    tabs.append(tab)
        if not tabs:
            tabs = [self._blank_tab()]
        active = ""
        if isinstance(raw, dict):
            active = str(raw.get("activeId") or "")
        ids = {t["id"] for t in tabs}
        if active not in ids:
            active = tabs[0]["id"]
        return {"activeId": active, "tabs": tabs}

    def _heal_restart(self, state: dict[str, Any]) -> None:
        """A process restart cannot resume an in-flight SDK stream."""
        for tab in state["tabs"]:
            was_live = bool(tab.get("running")) or any(
                m.get("streaming") for m in tab["messages"]
            )
            tab["running"] = False
            for msg in tab["messages"]:
                msg["streaming"] = False
            if was_live:
                self._add_system(
                    tab,
                    "Server restarted while this reply was still running. "
                    "The transcript is saved — send a message to continue.",
                )

    def _save_now(self, project_id: str) -> None:
        state = self._projects.get(project_id)
        if not state:
            return
        path = self._path(project_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            {"activeId": state["activeId"], "tabs": state["tabs"]},
            indent=2,
        )
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(payload)
        os.chmod(tmp, 0o600)
        tmp.replace(path)

    def _save_soon(self, project_id: str) -> None:
        current = self._save_tasks.get(project_id)
        if current and not current.done():
            return

        async def _later() -> None:
            await asyncio.sleep(0.4)
            self._save_now(project_id)

        self._save_tasks[project_id] = asyncio.create_task(_later())

    def flush_all(self) -> None:
        for project_id in list(self._projects):
            self._save_now(project_id)

    def _state(self, project_id: str) -> dict[str, Any]:
        state = self._projects.get(project_id)
        if state is None:
            state = self._load(project_id)
            self._projects[project_id] = state
            # Persist a restart heal so we do not append the same note twice.
            self._save_now(project_id)
        return state

    # --- shape ----------------------------------------------------------------

    def _blank_tab(self, cwd: str = "", title: str = "", tab_id: str = "") -> dict[str, Any]:
        leaf = [p for p in (cwd or "").split("/") if p]
        if not title:
            title = f"./{leaf[-1]}" if leaf else "New chat"
        return {
            "id": tab_id or _new_id(),
            "title": title[:80],
            "cwd": (cwd or "")[:500],
            "messages": [],
            "agentId": None,
            "mode": "agent",
            "updatedAt": _now_ms(),
            "running": False,
        }

    def _sanitize_tab(self, raw: Any) -> Optional[dict[str, Any]]:
        if not isinstance(raw, dict):
            return None
        tab_id = str(raw.get("id") or "")
        if not _ID_OK.match(tab_id):
            tab_id = _new_id()
        tab = self._blank_tab(
            cwd=str(raw.get("cwd") or ""),
            title=str(raw.get("title") or ""),
            tab_id=tab_id,
        )
        agent = raw.get("agentId")
        tab["agentId"] = str(agent) if agent else None
        mode = str(raw.get("mode") or "agent")
        if mode in {"agent", "ask", "plan", "debug"}:
            tab["mode"] = mode
        messages = raw.get("messages")
        if isinstance(messages, list):
            for item in messages[-MAX_MESSAGES:]:
                msg = self._sanitize_message(item)
                if msg:
                    tab["messages"].append(msg)
        try:
            tab["updatedAt"] = int(raw.get("updatedAt") or _now_ms())
        except (TypeError, ValueError):
            tab["updatedAt"] = _now_ms()
        tab["running"] = bool(raw.get("running"))
        return tab

    def _sanitize_message(self, raw: Any) -> Optional[dict[str, Any]]:
        if not isinstance(raw, dict):
            return None
        role = str(raw.get("role") or "")
        if role not in {"user", "assistant", "thinking", "tool", "file", "system", "status"}:
            return None
        msg: dict[str, Any] = {
            "id": str(raw.get("id") or _new_id())[:40],
            "role": role,
            "streaming": bool(raw.get("streaming")),
        }
        if raw.get("text"):
            msg["text"] = _clip(str(raw.get("text")))
        try:
            if raw.get("at"):
                msg["at"] = int(raw["at"])
        except (TypeError, ValueError):
            pass
        try:
            if raw.get("durationMs") is not None:
                msg["durationMs"] = max(0, int(raw["durationMs"]))
        except (TypeError, ValueError):
            pass
        tool = raw.get("tool")
        if role == "tool" and isinstance(tool, dict):
            msg["tool"] = {
                "name": str(tool.get("name") or "tool")[:80],
                "status": str(tool.get("status") or "")[:40],
                "detail": _clip(str(tool.get("detail") or ""))[:500],
                "callId": str(tool.get("callId") or "")[:80] or None,
                "sessionId": str(tool.get("sessionId") or "")[:80] or None,
            }
        file = raw.get("file")
        if role == "file" and isinstance(file, dict) and file.get("path"):
            msg["file"] = {
                "path": str(file.get("path"))[:500],
                "action": str(file.get("action") or "touch")[:40],
            }
        return msg

    def _find(self, state: dict[str, Any], chat_id: str) -> Optional[dict[str, Any]]:
        for tab in state["tabs"]:
            if tab["id"] == chat_id:
                return tab
        return None

    def _has_transcript(self, state: dict[str, Any]) -> bool:
        for tab in state["tabs"]:
            for msg in tab["messages"]:
                if msg.get("role") in _REAL_ROLES:
                    return True
        return False

    def snapshot(self, project_id: str) -> dict[str, Any]:
        state = self._state(project_id)
        return {
            "activeId": state["activeId"],
            "tabs": copy.deepcopy(state["tabs"]),
            "importable": not self._has_transcript(state),
            "configured": bool(cursor_bridge.configured),
        }

    def project_running(self, project_id: str) -> bool:
        prefix = f"{project_id}:"
        return any(
            key.startswith(prefix) and not task.done()
            for key, task in self._tasks.items()
        )

    # --- subscribers ----------------------------------------------------------

    def subscribe(self, project_id: str, ws: Any) -> dict[str, Any]:
        self._subs.setdefault(project_id, set()).add(ws)
        return self.snapshot(project_id)

    def unsubscribe(self, project_id: str, ws: Any) -> None:
        """Drop a browser. Does not stop the agent."""
        subs = self._subs.get(project_id)
        if subs is not None:
            subs.discard(ws)

    async def broadcast(self, project_id: str, payload: dict[str, Any]) -> None:
        dead: list[Any] = []
        for ws in list(self._subs.get(project_id, ())):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.unsubscribe(project_id, ws)

    async def broadcast_workspace(self, project_id: str) -> None:
        snap = self.snapshot(project_id)
        await self.broadcast(project_id, {"type": "workspace", **snap})

    async def _push_tab(self, project_id: str, chat_id: str) -> None:
        state = self._state(project_id)
        tab = self._find(state, chat_id)
        if not tab:
            return
        await self.broadcast(
            project_id,
            {"type": "tab", "chatId": chat_id, "tab": copy.deepcopy(tab)},
        )

    # --- tabs -----------------------------------------------------------------

    async def create_tab(self, project_id: str, cwd: str = "", title: str = "") -> dict[str, Any]:
        state = self._state(project_id)
        tab = self._blank_tab(cwd=cwd, title=title)
        state["tabs"].append(tab)
        while len(state["tabs"]) > MAX_TABS:
            drop = next((t for t in state["tabs"] if not t.get("running")), state["tabs"][0])
            if drop["id"] == tab["id"]:
                break
            state["tabs"].remove(drop)
        state["activeId"] = tab["id"]
        self._save_now(project_id)
        await self.broadcast_workspace(project_id)
        return tab

    async def select(self, project_id: str, chat_id: str) -> None:
        """Remember which chat a new browser should open. Do not move the others."""
        state = self._state(project_id)
        if not self._find(state, chat_id):
            return
        if state["activeId"] == chat_id:
            return
        state["activeId"] = chat_id
        self._save_soon(project_id)

    async def delete_tab(self, project_id: str, chat_id: str) -> None:
        state = self._state(project_id)
        if len(state["tabs"]) <= 1:
            return
        await self._stop_run(project_id, chat_id, invalidate=True)
        state = self._state(project_id)
        state["tabs"] = [t for t in state["tabs"] if t["id"] != chat_id]
        if not state["tabs"]:
            state["tabs"] = [self._blank_tab()]
        if state["activeId"] == chat_id or not self._find(state, state["activeId"]):
            state["activeId"] = state["tabs"][0]["id"]
        self._save_now(project_id)
        await self.broadcast_workspace(project_id)

    def import_local(self, project_id: str, tabs: Any, active_id: str = "") -> bool:
        """Adopt this browser's old local chats once, if the server has none."""
        state = self._state(project_id)
        if self._has_transcript(state):
            return False
        if not isinstance(tabs, list):
            return False
        cleaned = []
        for item in tabs[:MAX_TABS]:
            tab = self._sanitize_tab(item)
            if tab and tab["messages"]:
                cleaned.append(tab)
        if not cleaned:
            return False
        for tab in cleaned:
            tab["running"] = False
            for msg in tab["messages"]:
                msg["streaming"] = False
        # Keep ids so the saved Cursor agent (project:chatId) still matches.
        state["tabs"] = cleaned
        ids = {t["id"] for t in cleaned}
        state["activeId"] = active_id if active_id in ids else cleaned[0]["id"]
        self._save_now(project_id)
        return True

    # --- runs -----------------------------------------------------------------

    def _running(self, project_id: str, chat_id: str) -> bool:
        task = self._tasks.get(_session_key(project_id, chat_id))
        return bool(task and not task.done())

    async def send(
        self,
        project_id: str,
        *,
        chat_id: str,
        prompt: str,
        model: Optional[str] = None,
        mode: Optional[str] = None,
        cwd: Optional[str] = None,
    ) -> None:
        prompt = (prompt or "").strip()
        if not prompt:
            return
        state = self._state(project_id)
        cid = (chat_id or "").strip() or state["activeId"]
        tab = self._find(state, cid)
        if tab is None:
            tab = self._blank_tab(cwd=cwd or "", tab_id=cid if _ID_OK.match(cid) else "")
            state["tabs"].append(tab)
            state["activeId"] = tab["id"]
            cid = tab["id"]
        if self._running(project_id, cid):
            await self.broadcast(
                project_id,
                {
                    "type": "error",
                    "error": "Agent is already working on this chat — wait or press Stop, then retry.",
                    "chatId": cid,
                    "recoverable": True,
                    "busy": True,
                },
            )
            return

        if cwd:
            tab["cwd"] = cwd[:500]
        if mode in {"agent", "ask", "plan", "debug"}:
            tab["mode"] = mode
        user_count = sum(1 for m in tab["messages"] if m.get("role") == "user")
        title = tab.get("title") or ""
        if user_count == 0 and (title == "New chat" or title.startswith("./")):
            tab["title"] = prompt[:32] + ("…" if len(prompt) > 32 else "")
        self._add_message(
            tab,
            {"id": _new_id(), "role": "user", "text": prompt, "at": _now_ms()},
        )
        tab["running"] = True
        tab["updatedAt"] = _now_ms()
        self._save_now(project_id)
        await self._push_tab(project_id, cid)

        key = _session_key(project_id, cid)
        self._generation[key] = self._generation.get(key, 0)
        self._saw_deltas[key] = False
        self._stop_notes.discard(key)
        self._tasks[key] = asyncio.create_task(
            self._run(project_id, cid, prompt, model=model, mode=mode, cwd=tab.get("cwd") or None),
            name=f"chat-run:{key}",
        )

    async def cancel(self, project_id: str, chat_id: str) -> bool:
        """Ask Cursor to stop. The task keeps reading until the run actually ends."""
        key = _session_key(project_id, chat_id)
        if not self._running(project_id, chat_id):
            self._stop_notes.discard(key)
            await self.broadcast(
                project_id, {"type": "cancelled", "ok": False, "chatId": chat_id}
            )
            return False
        self._stop_notes.add(key)
        ok = await cursor_bridge.cancel(project_id, chat_id=chat_id)
        await self.broadcast(
            project_id, {"type": "cancelled", "ok": ok, "chatId": chat_id}
        )
        return ok

    async def reset(self, project_id: str, chat_id: str) -> None:
        await self._stop_run(project_id, chat_id, invalidate=True)
        await cursor_bridge.reset_agent(project_id, chat_id=chat_id)
        state = self._state(project_id)
        tab = self._find(state, chat_id)
        if tab is None:
            return
        tab["messages"] = []
        tab["agentId"] = None
        tab["running"] = False
        tab["updatedAt"] = _now_ms()
        self._save_now(project_id)
        await self._push_tab(project_id, chat_id)

    async def _stop_run(self, project_id: str, chat_id: str, *, invalidate: bool) -> None:
        key = _session_key(project_id, chat_id)
        if invalidate:
            self._generation[key] = self._generation.get(key, 0) + 1
            self._stop_notes.discard(key)
        try:
            await cursor_bridge.cancel(project_id, chat_id=chat_id)
        except Exception as e:
            log.warning("cancel before stop: %s", e)
        task = self._tasks.get(key)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks.pop(key, None)

    async def _run(
        self,
        project_id: str,
        chat_id: str,
        prompt: str,
        *,
        model: Optional[str],
        mode: Optional[str],
        cwd: Optional[str],
    ) -> None:
        key = _session_key(project_id, chat_id)
        generation = self._generation.get(key, 0)
        try:
            async for event in cursor_bridge.send_stream(
                project_id,
                prompt,
                model=model,
                mode=mode,
                chat_id=chat_id,
                cwd=cwd,
            ):
                if self._generation.get(key, 0) != generation:
                    return
                changed = self.apply_event(project_id, chat_id, event)
                await self.broadcast(project_id, event)
                if not changed:
                    continue
                immediate = event.get("type") not in {"text-delta", "text", "thinking-delta"}
                now = time.monotonic()
                if immediate or now - self._last_push.get(key, 0) >= PUSH_INTERVAL_SEC:
                    await self._push_tab(project_id, chat_id)
                    self._last_push[key] = now
                    self._save_soon(project_id)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("chat run %s: %s", key, e)
            if self._generation.get(key, 0) == generation:
                self.apply_event(
                    project_id,
                    chat_id,
                    {
                        "type": "error",
                        "error": str(e),
                        "chatId": chat_id,
                        "recoverable": True,
                    },
                )
        finally:
            current = self._tasks.get(key)
            if current is asyncio.current_task():
                self._tasks.pop(key, None)
            if self._generation.get(key, 0) != generation:
                return
            state = self._state(project_id)
            tab = self._find(state, chat_id)
            if tab:
                self._finish_bubbles(tab)
                if key in self._stop_notes:
                    self._stop_notes.discard(key)
                    self._add_system(tab, "Run cancelled — you can continue this chat.")
                tab["running"] = False
                tab["updatedAt"] = _now_ms()
            self._save_now(project_id)
            await self._push_tab(project_id, chat_id)

    # --- fold events into the transcript -------------------------------------

    def apply_event(self, project_id: str, chat_id: str, event: dict[str, Any]) -> bool:
        """Update the stored transcript. Returns True when a browser should refresh it."""
        state = self._state(project_id)
        tab = self._find(state, chat_id)
        if not tab or not isinstance(event, dict):
            return False
        kind = event.get("type")
        key = _session_key(project_id, chat_id)
        changed = False

        if kind == "agent":
            if event.get("agentId"):
                tab["agentId"] = str(event["agentId"])
                changed = True
            if event.get("mode") in {"agent", "ask", "plan", "debug"}:
                tab["mode"] = event["mode"]
                changed = True
        elif kind == "run":
            self._saw_deltas[key] = False
            tab["running"] = True
            changed = True
        elif kind in {"text-delta", "text"}:
            chunk = str(event.get("text") or "")
            if chunk:
                self._saw_deltas[key] = True
                current = self._turn_text(tab, "assistant")
                self._write_turn(tab, "assistant", append_stream_chunk(current, chunk), streaming=True)
                changed = True
        elif kind == "thinking-delta":
            chunk = str(event.get("text") or "")
            if chunk:
                current = self._turn_text(tab, "thinking")
                self._write_turn(tab, "thinking", append_stream_chunk(current, chunk), streaming=True)
                changed = True
        elif kind == "thinking-completed":
            ms = event.get("ms")
            try:
                duration_ms = int(ms) if ms is not None else None
            except (TypeError, ValueError):
                duration_ms = None
            self._close_thinking(tab, duration_ms=duration_ms)
            changed = True
        elif kind == "tool-delta":
            self._upsert_tool(tab, event)
            changed = True
        elif kind == "message":
            changed = self._apply_sdk(tab, event.get("message") or {}, key)
        elif kind == "done":
            self._finish_bubbles(tab)
            tab["running"] = False
            status = str(event.get("status") or "").lower()
            if status in {"error", "failed"}:
                self._add_system(
                    tab,
                    f"Agent run ended with error ({event.get('status')}) — you can continue this chat.",
                )
            changed = True
        elif kind == "error":
            if event.get("busy"):
                return False
            self._finish_bubbles(tab)
            tab["running"] = False
            detail = str(event.get("error") or "Agent error")
            self._add_system(
                tab,
                f"⚠ {detail} — chat is still open; cancel if stuck, then send again.",
            )
            changed = True
        elif kind == "cancelled":
            self._finish_bubbles(tab)
            tab["running"] = False
            self._add_system(tab, "Run cancelled — you can continue this chat.")
            changed = True

        if changed:
            tab["updatedAt"] = _now_ms()
            self._trim(tab)
        return changed

    def _turn_text(self, tab: dict[str, Any], role: str) -> str:
        idx = self._turn_index(tab["messages"], role)
        if idx < 0:
            return ""
        return str(tab["messages"][idx].get("text") or "")

    def _turn_index(self, messages: list[dict[str, Any]], role: str) -> int:
        """Latest bubble of this role since the last user prompt."""
        for i in range(len(messages) - 1, -1, -1):
            msg = messages[i]
            if msg.get("role") == role:
                return i
            if msg.get("role") == "user":
                break
        return -1

    def _write_turn(self, tab: dict[str, Any], role: str, text: str, *, streaming: bool) -> None:
        messages = tab["messages"]
        idx = self._turn_index(messages, role)
        body = _clip(text)
        if role in {"assistant", "thinking"}:
            body = _clip(collapse_doubled_tokens(body))
        if idx >= 0:
            messages[idx]["text"] = body
            messages[idx]["streaming"] = streaming
            return
        self._add_message(
            tab,
            {
                "id": _new_id(),
                "role": role,
                "text": body,
                "streaming": streaming,
                "at": _now_ms(),
            },
        )

    def _close_thinking(
        self, tab: dict[str, Any], *, duration_ms: Optional[int] = None
    ) -> None:
        for msg in reversed(tab["messages"]):
            if msg.get("role") == "user":
                break
            if msg.get("role") == "thinking" and msg.get("streaming"):
                msg["streaming"] = False
                if duration_ms is not None and duration_ms >= 0:
                    msg["durationMs"] = duration_ms
                elif msg.get("at"):
                    try:
                        msg["durationMs"] = max(0, _now_ms() - int(msg["at"]))
                    except (TypeError, ValueError):
                        pass
                break

    def _finish_bubbles(self, tab: dict[str, Any]) -> None:
        for msg in tab["messages"]:
            if msg.get("streaming"):
                msg["streaming"] = False

    def _add_message(self, tab: dict[str, Any], msg: dict[str, Any]) -> None:
        tab["messages"].append(msg)
        self._trim(tab)

    def _add_system(self, tab: dict[str, Any], text: str) -> None:
        messages = tab["messages"]
        if messages and messages[-1].get("role") == "system" and messages[-1].get("text") == text:
            return
        self._add_message(
            tab,
            {"id": _new_id(), "role": "system", "text": text, "at": _now_ms()},
        )

    def _trim(self, tab: dict[str, Any]) -> None:
        messages = tab["messages"]
        if len(messages) > MAX_MESSAGES:
            tab["messages"] = messages[-MAX_MESSAGES:]

    def _upsert_tool(self, tab: dict[str, Any], event: dict[str, Any]) -> None:
        call_id = str(event.get("callId") or "") or None
        name = str(event.get("name") or "tool")
        status = str(event.get("status") or "running")
        detail = str(event.get("summary") or event.get("detail") or "")
        session_id = str(event.get("sessionId") or "") or None
        messages = tab["messages"]
        idx = -1
        if call_id:
            for i, msg in enumerate(messages):
                if msg.get("role") == "tool" and (msg.get("tool") or {}).get("callId") == call_id:
                    idx = i
                    break
        prev_status = messages[idx]["tool"].get("status") if idx >= 0 else None
        prev_session = messages[idx]["tool"].get("sessionId") if idx >= 0 else None
        tool = {
            "name": name,
            "status": status,
            "detail": detail or (messages[idx]["tool"].get("detail") if idx >= 0 else ""),
            "callId": call_id,
            "sessionId": session_id or prev_session,
        }
        if idx >= 0:
            messages[idx]["tool"] = tool
        else:
            self._add_message(tab, {"id": _new_id(), "role": "tool", "tool": tool, "at": _now_ms()})
        file = event.get("file") if isinstance(event.get("file"), dict) else None
        if status == "completed" and prev_status != "completed" and file and file.get("path"):
            path = str(file["path"])
            already = any(
                m.get("role") == "file" and (m.get("file") or {}).get("path") == path
                for m in tab["messages"]
            )
            if not already:
                self._add_message(
                    tab,
                    {
                        "id": _new_id(),
                        "role": "file",
                        "file": {"path": path, "action": str(file.get("action") or "edit")},
                        "at": _now_ms(),
                    },
                )

    def _apply_sdk(self, tab: dict[str, Any], message: dict[str, Any], key: str) -> bool:
        if not isinstance(message, dict):
            return False
        kind = message.get("type")
        if kind == "thinking":
            text = str(message.get("text") or "")
            if not text:
                return False
            current = self._turn_text(tab, "thinking")
            self._write_turn(tab, "thinking", append_stream_chunk(current, text), streaming=False)
            return True
        if kind == "tool_call":
            self._upsert_tool(
                tab,
                {
                    "callId": message.get("callId") or message.get("call_id"),
                    "name": message.get("name") or "tool",
                    "status": message.get("status") or "running",
                    "summary": message.get("summary"),
                    "sessionId": message.get("sessionId"),
                    "file": message.get("file"),
                },
            )
            return True
        if kind in {"status", "task"}:
            return False
        blocks = message.get("content") or []
        text = ""
        if isinstance(blocks, list):
            text = "".join(
                str(b.get("text") or "")
                for b in blocks
                if isinstance(b, dict) and b.get("type") == "text"
            )
        if not text:
            return False
        current = self._turn_text(tab, "assistant")
        saw = self._saw_deltas.get(key, False)
        if saw and current:
            # Live deltas already own the bubble — only adopt a longer/equal snapshot.
            if text.startswith(current) or current.startswith(text):
                merged = text if len(text) >= len(current) else current
            elif text in current:
                return False
            else:
                merged = merge_assistant_text(current, text, prefer_next=True)
        else:
            merged = merge_assistant_text(current, text, prefer_next=saw)
        self._write_turn(tab, "assistant", merged, streaming=False)
        return True


chat_workspace = ChatWorkspace()
