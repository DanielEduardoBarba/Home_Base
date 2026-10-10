"""Locate cursor-sdk-bridge for Nuitka/prod (package data is often missing)."""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

log = logging.getLogger("homebase.cursor")

_ENV = "CURSOR_SDK_BRIDGE_BIN"


def _candidates() -> list[Path]:
    share = Path(os.environ.get("HOMEBASE_SHARE", "/usr/share/homebased"))
    out = [
        share / "cursor-sdk-bridge" / "bin" / "cursor-sdk-bridge",
        Path("/usr/share/homebased/cursor-sdk-bridge/bin/cursor-sdk-bridge"),
    ]
    # Dev: venv next to source tree
    try:
        from server_py.config import BUNDLE_ROOT

        root = BUNDLE_ROOT
    except Exception:
        here = Path(__file__).resolve().parent
        root = here.parent.parent if here.name == "server_py" else here.parent
    for pattern in (
        root / ".venv" / "lib",
    ):
        if not pattern.is_dir():
            continue
        for path in pattern.glob("python*/site-packages/cursor_sdk/_vendor/bridge/bin/cursor-sdk-bridge"):
            out.append(path)
    return out


def ensure_cursor_bridge_env() -> Optional[str]:
    """
    Ensure CURSOR_SDK_BRIDGE_BIN points at a real launcher.

    Nuitka one-file builds omit the ~180MB cursor_sdk/_vendor/bridge tree, so
    production must use the copy installed under HOMEBASE_SHARE by deploy.
    """
    override = os.environ.get(_ENV, "").strip()
    if override and Path(override).expanduser().is_file():
        path = str(Path(override).expanduser().resolve())
        os.environ[_ENV] = path
        return path

    # Prefer wheel-bundled launcher when present (dev venv / full install)
    try:
        from cursor_sdk._vendor import resolve_bridge_path

        path = resolve_bridge_path()
        if path and Path(path).is_file():
            os.environ[_ENV] = path
            return path
    except Exception:
        pass

    for candidate in _candidates():
        if candidate.is_file():
            resolved = str(candidate.resolve())
            os.environ[_ENV] = resolved
            log.info("CURSOR_SDK_BRIDGE_BIN → %s", resolved)
            return resolved

    log.warning(
        "cursor-sdk-bridge not found — deploy with ./build.sh --service "
        "(copies bridge into /usr/share/homebased) or set %s",
        _ENV,
    )
    return None
