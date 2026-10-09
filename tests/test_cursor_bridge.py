"""Unit tests for Cursor bridge recovery helpers."""

from __future__ import annotations

from server.cursor_bridge import _is_active_run_conflict, CursorBridge


def test_active_run_conflict_detection():
    assert _is_active_run_conflict(
        RuntimeError(
            "internal: Agent 89ed75cd-57af-4e56-9437-c4f672e4054a already has active run"
        )
    )
    assert _is_active_run_conflict(Exception("Active Run exists"))
    assert not _is_active_run_conflict(Exception("model not found"))


def test_emit_error_event_is_recoverable():
    bridge = CursorBridge()
    evt = bridge._emit_error_event(
        "homebase",
        "chat1",
        "boom mid stream",
        key="homebase:chat1",
    )
    assert evt["type"] == "error"
    assert evt["recoverable"] is True
    assert evt["chatId"] == "chat1"
    assert "boom" in evt["error"]
