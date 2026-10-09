"""PATH enrichment for PTY shells (pnpm / nvm)."""
from __future__ import annotations

import os
from pathlib import Path

from server.shell_env import enrich_shell_env


def test_enrich_includes_pnpm_from_seat_home(tmp_path: Path, monkeypatch):
    home = tmp_path / "daniel"
    nvm_bin = home / ".nvm" / "versions" / "node" / "v24.14.1" / "bin"
    pnpm_home = home / ".local" / "share" / "pnpm"
    nvm_bin.mkdir(parents=True)
    pnpm_home.mkdir(parents=True)
    (nvm_bin / "pnpm").write_text("#!/bin/sh\n")
    (nvm_bin / "node").write_text("#!/bin/sh\n")
    os.chmod(nvm_bin / "pnpm", 0o755)

    monkeypatch.setenv("HOMEBASE_VIEW_UID", str(os.getuid()))
    monkeypatch.setattr(
        "server.shell_env._seat_home",
        lambda: home,
    )

    env = enrich_shell_env({"PATH": "/usr/bin:/bin", "HOME": "/root"})
    path = env["PATH"]
    assert str(nvm_bin) in path.split(":")
    assert path.split(":")[0] in {str(pnpm_home), str(nvm_bin), str(home / ".local" / "bin")}
    assert "/usr/bin" in path


def test_enrich_preserves_caller_overrides():
    env = enrich_shell_env({"PATH": "/custom/bin:/usr/bin", "FOO": "bar"})
    assert env["FOO"] == "bar"
    assert env["PATH"].endswith("/custom/bin:/usr/bin") or "/custom/bin" in env["PATH"]
