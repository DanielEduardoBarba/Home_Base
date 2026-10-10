from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import RUNTIME_DIR

LOG_DIR = RUNTIME_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)


def _day_path(day: str | None = None) -> Path:
    d = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return LOG_DIR / f"{d}.log"


def append_daily(event: str, **fields: Any) -> None:
    """Append one JSON line to today's log. Bounded growth: one file per UTC day."""
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **fields,
    }
    path = _day_path()
    line = json.dumps(payload, default=str) + "\n"
    with path.open("a", encoding="utf-8") as f:
        f.write(line)


def read_daily(day: str | None = None, limit: int = 200, offset: int = 0) -> dict[str, Any]:
    path = _day_path(day)
    if not path.is_file():
        return {"day": day or datetime.now(timezone.utc).strftime("%Y-%m-%d"), "total": 0, "items": []}
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    total = len(lines)
    # newest first
    sliced = list(reversed(lines))[offset : offset + limit]
    items = []
    for line in sliced:
        try:
            items.append(json.loads(line))
        except json.JSONDecodeError:
            items.append({"raw": line})
    return {
        "day": day or datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": items,
    }
