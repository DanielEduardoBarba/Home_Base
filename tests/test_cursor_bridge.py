"""Unit tests for Cursor bridge recovery helpers."""

from __future__ import annotations

from server.approvals import get_policy, set_policy
from server.cursor_bridge import (
    _is_active_run_conflict,
    _resolve_mode,
    _sdk_mode,
    CursorBridge,
)
from server.homebase_tools import build_homebase_tools


def test_active_run_conflict_detection():
    assert _is_active_run_conflict(
        RuntimeError(
            "internal: Agent 89ed75cd-57af-4e56-9437-c4f672e4054a already has active run"
        )
    )
    assert _is_active_run_conflict(Exception("Active Run exists"))
    assert not _is_active_run_conflict(Exception("model not found"))


def test_mode_mapping():
    assert _resolve_mode("PLAN") == "plan"
    assert _resolve_mode("nope") == "agent"
    assert _sdk_mode("plan") == "plan"
    assert _sdk_mode("ask") == "agent"
    assert _sdk_mode("debug") == "agent"


def test_ask_tools_readonly():
    tools = build_homebase_tools("homebase", readonly=True)
    assert "homebase_run_action" not in tools
    assert "homebase_stop" not in tools
    assert "homebase_list_projects" in tools


def test_approval_policy():
    assert set_policy("auto") == "auto"
    assert get_policy() == "auto"
    assert set_policy("weird") == "ask"


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
