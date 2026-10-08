from __future__ import annotations

import os
from pathlib import Path

from .config import BUNDLE_ROOT, ROOT

_FALLBACK = "0.0.0"


def read_version() -> str:
    for candidate in (
        BUNDLE_ROOT / "VERSION",
        ROOT / "VERSION",
        Path("/usr/share/homebased/VERSION"),
    ):
        try:
            if candidate.is_file():
                v = candidate.read_text(encoding="utf-8").strip().splitlines()[0].strip()
                if v:
                    return v
        except OSError:
            continue
    return _FALLBACK


def running_as_backup() -> bool:
    if os.environ.get("HOMEBASE_RUNNING_BACKUP", "").strip() in ("1", "true", "yes"):
        return True
    marker = Path("/usr/share/homebased/.running-backup")
    try:
        return marker.is_file()
    except OSError:
        return False


def status_payload() -> dict:
    return {
        "version": read_version(),
        "backup": running_as_backup(),
    }
