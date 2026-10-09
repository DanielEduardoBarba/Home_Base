"""Control plane must not be killed via project Stop / kill_ports."""

from __future__ import annotations

import os
from unittest.mock import patch

from server import ports


def test_control_plane_ports_from_env(monkeypatch):
    monkeypatch.setenv("HOMEBASE_PORT", "8888")
    assert ports.control_plane_ports() == {8888}
    monkeypatch.delenv("HOMEBASE_PORT", raising=False)
    assert ports.control_plane_ports() == set()


def test_kill_ports_skips_control_plane_listen_port(monkeypatch):
    monkeypatch.setenv("HOMEBASE_PORT", "8888")
    called: list[int] = []

    def fake_pids(port: int) -> set[int]:
        called.append(port)
        return {99999}

    with patch.object(ports, "pids_on_port", side_effect=fake_pids):
        with patch.object(ports, "kill_pids", return_value=[]) as kp:
            out = ports.kill_ports([8888, 4200])
    assert out == []
    assert called == [4200]
    kp.assert_called_once_with({99999})


def test_is_protected_pid_homebased_cgroup(monkeypatch):
    monkeypatch.setattr(ports, "pid_in_homebased_unit", lambda pid: pid == 424242)
    monkeypatch.setattr(ports, "_self_ancestry", lambda: {os.getpid()})
    assert ports.is_protected_pid(424242) is True
    assert ports.is_protected_pid(7) is False


def test_kill_pids_skips_protected(monkeypatch):
    monkeypatch.setattr(ports, "is_protected_pid", lambda pid: pid == 111)
    signaled: list[int] = []

    def fake_kill(pid, sig):
        signaled.append(pid)

    with patch.object(ports.os, "killpg", side_effect=fake_kill):
        with patch.object(ports.os, "kill", side_effect=fake_kill):
            stopped = ports.kill_pids([111, 222])
    assert 111 not in stopped
    assert 222 in stopped
