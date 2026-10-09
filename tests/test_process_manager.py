"""Compose Logs fallback + stateDir ownership helpers."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from server.process_manager import ensure_project_state_writable, tail_logs
from server.pty_manager import PtySession, pty_manager
from server.shell_env import SeatUser


def test_output_tail_joins_run_expo_buffers():
    sid_run = "testrun000001"
    sid_expo = "testexpo00001"
    try:
        run = PtySession(
            id=sid_run,
            kind="run",
            project_id="clocktrakr",
            cwd="/tmp",
            cmdline=["echo"],
            proc=SimpleNamespace(),  # type: ignore[arg-type]
            created_at=0.0,
            label="Run",
        )
        run.append_output("api ready\n")
        expo = PtySession(
            id=sid_expo,
            kind="expo",
            project_id="clocktrakr",
            cwd="/tmp",
            cmdline=["echo"],
            proc=SimpleNamespace(),  # type: ignore[arg-type]
            created_at=0.0,
            label="Expo",
        )
        expo.append_output("Metro waiting\n")
        pty_manager._sessions[sid_run] = run
        pty_manager._sessions[sid_expo] = expo

        text = pty_manager.output_tail("clocktrakr", kinds={"run", "expo"}, lines=50)
        assert "api ready" in text
        assert "Metro waiting" in text
        assert "--- run:" in text
        assert "--- expo:" in text
    finally:
        pty_manager._sessions.pop(sid_run, None)
        pty_manager._sessions.pop(sid_expo, None)


def test_tail_logs_falls_back_to_pty(tmp_path: Path, monkeypatch):
    state = tmp_path / ".clocktrakr"
    state.mkdir()
    stack = state / "stack.log"
    stack.write_text("")

    project = SimpleNamespace(
        id="clocktrakr",
        path=tmp_path,
        state_dir=".clocktrakr",
        stack_log=stack,
    )
    monkeypatch.setattr(
        "server.process_manager.get_project",
        lambda _pid: project,
    )

    sid = "testtail00001"
    try:
        sess = PtySession(
            id=sid,
            kind="run",
            project_id="clocktrakr",
            cwd=str(tmp_path),
            cmdline=["echo"],
            proc=SimpleNamespace(),  # type: ignore[arg-type]
            created_at=0.0,
            label="Run",
        )
        sess.append_output("[api] listening on 4200\n")
        pty_manager._sessions[sid] = sess

        out = tail_logs("clocktrakr", lines=20)
        assert out["source"] == "pty"
        assert "listening on 4200" in out["text"]
    finally:
        pty_manager._sessions.pop(sid, None)


def test_tail_logs_prefers_nonempty_file(tmp_path: Path, monkeypatch):
    state = tmp_path / ".clocktrakr"
    state.mkdir()
    stack = state / "stack.log"
    stack.write_text("from file\n")

    project = SimpleNamespace(
        id="clocktrakr",
        path=tmp_path,
        state_dir=".clocktrakr",
        stack_log=stack,
    )
    monkeypatch.setattr(
        "server.process_manager.get_project",
        lambda _pid: project,
    )
    out = tail_logs("clocktrakr", lines=20)
    assert out["source"] == "file"
    assert "from file" in out["text"]


def test_ensure_project_state_writable_creates_tmp(tmp_path: Path, monkeypatch):
    project = SimpleNamespace(
        id="clocktrakr",
        path=tmp_path,
        state_dir=".clocktrakr",
    )
    monkeypatch.setattr(
        "server.process_manager.resolve_seat_user",
        lambda: SeatUser(uid=1000, gid=1000, name="daniel", home="/home/daniel", shell="/bin/bash"),
    )
    monkeypatch.setattr("server.process_manager.os.geteuid", lambda: 0)
    # chown may fail in some CI sandboxes — helper must still create dirs.
    monkeypatch.setattr(
        "server.process_manager._chown_tree",
        lambda path, uid, gid: None,
    )
    ensure_project_state_writable(project)  # type: ignore[arg-type]
    assert (tmp_path / ".clocktrakr" / "tmp").is_dir()
