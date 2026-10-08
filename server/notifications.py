from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from .config import NOTIFICATIONS_PATH, RUNTIME_DIR

# Cap on-disk history to avoid unbounded growth
MAX_NOTIFICATIONS = 2000
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_all() -> list[dict[str, Any]]:
    if not NOTIFICATIONS_PATH.is_file():
        return []
    items: list[dict[str, Any]] = []
    with NOTIFICATIONS_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                items.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return items


def _rewrite(items: list[dict[str, Any]]) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    # keep newest MAX_NOTIFICATIONS
    if len(items) > MAX_NOTIFICATIONS:
        items = items[-MAX_NOTIFICATIONS:]
    tmp = NOTIFICATIONS_PATH.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for item in items:
            f.write(json.dumps(item, default=str) + "\n")
    tmp.replace(NOTIFICATIONS_PATH)


def push(
    title: str,
    body: str = "",
    *,
    level: str = "info",
    category: str = "system",
    meta: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    item = {
        "id": uuid.uuid4().hex,
        "ts": _now(),
        "title": title,
        "body": body,
        "level": level,  # info | warn | error | success
        "category": category,
        "read": False,
        "meta": meta or {},
    }
    with _lock:
        items = _read_all()
        items.append(item)
        _rewrite(items)
    return item


def list_notifications(
    *,
    offset: int = 0,
    limit: int = 30,
    unread_only: bool = False,
    history: bool = False,
) -> dict[str, Any]:
    """Newest-first pagination. history=True includes read; False focuses inbox."""
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    with _lock:
        items = _read_all()
    items = list(reversed(items))
    if unread_only:
        items = [i for i in items if not i.get("read")]
    elif not history:
        # inbox: unread first, then recent read (still paginated from full newest list)
        pass
    total = len(items)
    unread = sum(1 for i in _read_all() if not i.get("read"))
    page = items[offset : offset + limit]
    return {
        "total": total,
        "unread": unread,
        "offset": offset,
        "limit": limit,
        "items": page,
    }


def mark_read(ids: Optional[list[str]] = None, *, all_read: bool = False) -> int:
    with _lock:
        items = _read_all()
        changed = 0
        id_set = set(ids or [])
        for item in items:
            if all_read or item.get("id") in id_set:
                if not item.get("read"):
                    item["read"] = True
                    changed += 1
        if changed:
            _rewrite(items)
        return changed


def clear_read() -> int:
    with _lock:
        items = _read_all()
        kept = [i for i in items if not i.get("read")]
        removed = len(items) - len(kept)
        if removed:
            _rewrite(kept)
        return removed
