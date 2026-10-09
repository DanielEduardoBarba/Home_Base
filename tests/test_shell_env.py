"""Native seat-user env for PTY shells (setpriv + login profile + PATH)."""
from __future__ import annotations

import os
from pathlib import Path

from server.shell_env import (
    SeatUser,
    clear_seat_env_cache,
    enrich_shell_env,
    resolve_seat_user,
    seat_cmdline,
)


def test_enrich_includes_pnpm_from_seat_home(tmp_path: Path, monkeypatch):
    home = tmp_path / "daniel"
    nvm_bin = home / ".nvm" / "versions" / "node" / "v24.14.1" / "bin"
    pnpm_home = home / ".local" / "share" / "pnpm"
    nvm_bin.mkdir(parents=True)
    pnpm_home.mkdir(parents=True)
    (nvm_bin / "pnpm").write_text("#!/bin/sh\n")
    (nvm_bin / "node").write_text("#!/bin/sh\n")
    os.chmod(nvm_bin / "pnpm", 0o755)

    clear_seat_env_cache()
    monkeypatch.setattr(
        "server.shell_env.resolve_seat_user",
        lambda: SeatUser(
            uid=1000,
            gid=1000,
            name="daniel",
            home=str(home),
            shell="/bin/bash",
        ),
    )
    monkeypatch.setattr(
        "server.shell_env._cached_seat_login_env",
        lambda seat: {
            "HOME": str(home),
            "USER": "daniel",
            "LOGNAME": "daniel",
            "SHELL": "/bin/bash",
            "PATH": "/usr/bin:/bin",
        },
    )
    monkeypatch.setattr("server.shell_env.os.geteuid", lambda: 0)

    env = enrich_shell_env({"FOO": "bar"})
    path = env["PATH"]
    assert str(nvm_bin) in path.split(":")
    assert env["HOME"] == str(home)
    assert env["USER"] == "daniel"
    assert env["FOO"] == "bar"
    # Stale root HOME in overrides must not stick.
    env2 = enrich_shell_env({"HOME": "/root", "USER": "root"})
    assert env2["HOME"] == str(home)
    assert env2["USER"] == "daniel"


def test_enrich_preserves_caller_overrides(monkeypatch):
    clear_seat_env_cache()
    monkeypatch.setattr("server.shell_env.resolve_seat_user", lambda: None)
    monkeypatch.setattr("server.shell_env._seat_home", lambda: None)
    env = enrich_shell_env({"PATH": "/custom/bin:/usr/bin", "FOO": "bar"})
    assert env["FOO"] == "bar"
    assert "/custom/bin" in env["PATH"]


def test_seat_cmdline_wraps_when_root(monkeypatch):
    seat = SeatUser(
        uid=1000, gid=1000, name="daniel", home="/home/daniel", shell="/bin/bash"
    )
    monkeypatch.setattr("server.shell_env.os.geteuid", lambda: 0)
    monkeypatch.setattr(
        "server.shell_env.shutil.which",
        lambda name: "/usr/bin/setpriv" if name == "setpriv" else None,
    )
    out = seat_cmdline(["bash", "-i"], seat)
    assert out[:5] == [
        "/usr/bin/setpriv",
        "--reuid=1000",
        "--regid=1000",
        "--init-groups",
        "--",
    ]
    assert out[-2:] == ["bash", "-i"]


def test_seat_cmdline_noop_when_not_root(monkeypatch):
    seat = SeatUser(
        uid=1000, gid=1000, name="daniel", home="/home/daniel", shell="/bin/bash"
    )
    monkeypatch.setattr("server.shell_env.os.geteuid", lambda: 1000)
    assert seat_cmdline(["bash", "-i"], seat) == ["bash", "-i"]


def test_resolve_seat_user_from_view_uid(monkeypatch):
    monkeypatch.setenv("HOMEBASE_VIEW_UID", str(os.getuid()))
    if os.getuid() == 0:
        monkeypatch.setenv("HOMEBASE_VIEW_UID", "1000")
    seat = resolve_seat_user()
    assert seat is not None
    assert seat.uid != 0
    assert seat.home.startswith("/home/") or Path(seat.home).is_dir()
