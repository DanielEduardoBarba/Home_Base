"""Server-owned chat workspace: one transcript, runs survive disconnects."""

from __future__ import annotations

import asyncio
import json

from server.chat_text import append_stream_chunk, merge_assistant_text
from server.chat_workspace import ChatWorkspace


class FakeWS:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


def _assistant(tab: dict) -> str:
    for msg in reversed(tab["messages"]):
        if msg.get("role") == "assistant":
            return msg.get("text") or ""
    return ""


def test_stream_chunk_keeps_growing_text():
    assert append_stream_chunk("", "Hello") == "Hello"
    assert append_stream_chunk("Hello", "Hello world") == "Hello world"
    assert append_stream_chunk("Hello world", "Hello") == "Hello world"
    assert merge_assistant_text("Hello wor", "Hello world", prefer_next=True) == "Hello world"


def test_stream_chunk_skips_duplicate_word_deltas():
    """SDK often re-sends each word bare then with a leading space."""
    text = ""
    for chunk in ("I", " I", "did", " did", "the", " the", "job", " job"):
        text = append_stream_chunk(text, chunk)
    assert text == "I did the job"


def test_stream_chunk_short_overlap():
    assert append_stream_chunk("I did", " did the") == "I did the"
    assert append_stream_chunk("Hello", "lo world") == "Hello world"


def test_run_continues_with_no_browsers(tmp_path, monkeypatch):
    async def go() -> None:
        import server.chat_workspace as mod

        monkeypatch.setattr(mod, "CHATS_DIR", tmp_path / "chats")
        hub = ChatWorkspace()
        hello = asyncio.Event()
        release = asyncio.Event()

        async def fake_stream(project_id, prompt, **kwargs):
            cid = kwargs.get("chat_id")
            yield {"type": "run", "chatId": cid, "model": "auto"}
            yield {"type": "text-delta", "chatId": cid, "text": "Hello"}
            hello.set()
            await release.wait()
            yield {"type": "text-delta", "chatId": cid, "text": " there"}
            yield {"type": "done", "chatId": cid, "status": "finished"}

        monkeypatch.setattr(mod.cursor_bridge, "send_stream", fake_stream)

        tab = await hub.create_tab("demo")
        first = FakeWS()
        second = FakeWS()
        hub.subscribe("demo", first)
        hub.subscribe("demo", second)

        await hub.send("demo", chat_id=tab["id"], prompt="Say hello")
        await asyncio.wait_for(hello.wait(), timeout=2)

        assert any(e.get("type") == "text-delta" for e in first.sent)
        assert any(e.get("type") == "text-delta" for e in second.sent)
        assert any(
            e.get("type") == "tab" and e["tab"]["messages"][-1]["role"] == "user"
            for e in second.sent
        )

        key = f"demo:{tab['id']}"
        task = hub._tasks[key]
        hub.unsubscribe("demo", first)
        hub.unsubscribe("demo", second)
        assert not task.done()

        release.set()
        await asyncio.wait_for(task, timeout=2)

        saved = next(t for t in hub.snapshot("demo")["tabs"] if t["id"] == tab["id"])
        assert _assistant(saved) == "Hello there"
        assert saved["running"] is False
        assert any(m.get("role") == "user" and m.get("text") == "Say hello" for m in saved["messages"])

        late = FakeWS()
        snap = hub.subscribe("demo", late)
        assert _assistant(next(t for t in snap["tabs"] if t["id"] == tab["id"])) == "Hello there"

        raw = json.loads((tmp_path / "chats" / "demo.json").read_text())
        assert _assistant(next(t for t in raw["tabs"] if t["id"] == tab["id"])) == "Hello there"

        for pending in list(hub._save_tasks.values()):
            pending.cancel()

    asyncio.run(go())


def test_import_once_and_keeps_chat_id(tmp_path, monkeypatch):
    import server.chat_workspace as mod

    monkeypatch.setattr(mod, "CHATS_DIR", tmp_path / "chats")
    hub = ChatWorkspace()
    hub.snapshot("demo")  # creates the empty workspace
    assert hub.snapshot("demo")["importable"] is True

    applied = hub.import_local(
        "demo",
        [
            {
                "id": "abc123def0",
                "title": "From the laptop",
                "cwd": "web",
                "messages": [
                    {"id": "m1", "role": "user", "text": "hello"},
                    {"id": "m2", "role": "assistant", "text": "hi"},
                ],
            }
        ],
        active_id="abc123def0",
    )
    assert applied is True
    snap = hub.snapshot("demo")
    assert snap["importable"] is False
    assert snap["activeId"] == "abc123def0"
    assert snap["tabs"][0]["messages"][0]["text"] == "hello"

    again = hub.import_local(
        "demo",
        [{"id": "zzzzzzzz", "title": "other", "messages": [{"role": "user", "text": "nope"}]}],
    )
    assert again is False
    assert hub.snapshot("demo")["activeId"] == "abc123def0"


def test_restart_closes_a_live_bubble(tmp_path, monkeypatch):
    import server.chat_workspace as mod

    monkeypatch.setattr(mod, "CHATS_DIR", tmp_path / "chats")
    path = tmp_path / "chats" / "demo.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "activeId": "abc123def0",
                "tabs": [
                    {
                        "id": "abc123def0",
                        "title": "Live",
                        "cwd": "",
                        "agentId": None,
                        "mode": "agent",
                        "updatedAt": 1,
                        "running": True,
                        "messages": [
                            {
                                "id": "a1",
                                "role": "assistant",
                                "text": "partial",
                                "streaming": True,
                            }
                        ],
                    }
                ],
            }
        )
    )
    hub = ChatWorkspace()
    tab = hub.snapshot("demo")["tabs"][0]
    assert tab["running"] is False
    assert tab["messages"][0]["streaming"] is False
    assert tab["messages"][-1]["role"] == "system"
    assert "restarted" in tab["messages"][-1]["text"].lower()
