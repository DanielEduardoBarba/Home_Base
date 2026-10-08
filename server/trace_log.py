"""Bounded in-memory trace log for the Logs UI (no unbounded growth)."""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Any

MAX_LINES = 300

_lock = threading.Lock()
_buf: deque[dict[str, Any]] = deque(maxlen=MAX_LINES)
_seq = 0


def append(level: str, message: str, *, source: str = "server", **extra: Any) -> dict[str, Any]:
    """Push one line. Oldest drops automatically when over MAX_LINES."""
    global _seq
    with _lock:
        _seq += 1
        item = {
            "id": _seq,
            "ts": time.time(),
            "level": level,
            "source": source,
            "message": message[:4000],
            **({k: v for k, v in extra.items() if v is not None}),
        }
        _buf.append(item)
        return item


def snapshot(limit: int = MAX_LINES, after_id: int = 0) -> dict[str, Any]:
    """Return newest lines (or only those newer than after_id). Cap at MAX_LINES."""
    lim = max(1, min(int(limit or MAX_LINES), MAX_LINES))
    with _lock:
        items = list(_buf)
        last_id = _seq
    if after_id > 0:
        items = [i for i in items if i["id"] > after_id]
    else:
        items = items[-lim:]
    if len(items) > lim:
        items = items[-lim:]
    return {"items": items, "lastId": last_id, "max": MAX_LINES}


class RingLogHandler(logging.Handler):
    """logging.Handler that feeds the ring buffer."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
        except Exception:
            msg = record.getMessage()
        try:
            append(record.levelname.lower(), msg, source="server", logger=record.name)
        except Exception:
            pass


def install_logging_handler() -> None:
    """Attach once to root logger so uvicorn + homebase share the same ring."""
    root = logging.getLogger()
    for h in root.handlers:
        if isinstance(h, RingLogHandler):
            return
    handler = RingLogHandler()
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
    root.addHandler(handler)
    append("info", "trace log ready", source="server")
