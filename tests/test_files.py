from __future__ import annotations

from pathlib import Path

import pytest

from server_py.config import Project
from server_py.files import _resolve


def _project(root: Path) -> Project:
    return Project(id="t", name="T", path=root)


def test_relative_escape_blocked(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "ok.txt").write_text("hi", encoding="utf-8")
    p = _project(root)

    assert _resolve(p, "ok.txt") == (root / "ok.txt").resolve()
    with pytest.raises(PermissionError):
        _resolve(p, "../outside.txt")


def test_absolute_path_allowed(tmp_path):
    """Intentional host browse: absolute API paths resolve anywhere."""
    other = tmp_path / "elsewhere"
    other.mkdir()
    target = other / "note.txt"
    target.write_text("x", encoding="utf-8")
    p = _project(tmp_path / "proj")
    (tmp_path / "proj").mkdir()

    resolved = _resolve(p, str(target))
    assert resolved == target.resolve()
