"""Keep crash and stop notes that outlive the process.

The Logs ring is in memory, so a dead process takes it with it. Uncaught
errors are appended to a small file, and the next start loads that file plus
recent journal lines (stop, fatal, traceback) back into the ring.
"""

from __future__ import annotations

import json
import logging
import sys
import traceback
from typing import Optional

from .config import RUNTIME_DIR
from .trace_log import append as trace_append

log = logging.getLogger("homebase.crash")

EVENTS_PATH = RUNTIME_DIR / "logs" / "service-events.jsonl"
CURSOR_PATH = RUNTIME_DIR / "logs" / "journal.cursor"
MAX_EVENTS = 80

# Substrings that mean "the service died or was stopped", not an access log.
_ERROR_MARKERS = (
    "traceback",
    "fatal python",
    "uncaught exception",
    "main process exited",
    "failed with result",
    "oom-kill",
    "killed process",
)
_WARN_MARKERS = (
    "stopping homebased",
    "stopped homebased",
    "shutting down",
    "application shutdown complete",
    "finished server process",
    "start request repeated too quickly",
)


def incident_level(line: str) -> Optional[str]:
    """Return a Logs level for a journal line, or None to skip it."""
    low = (line or "").lower()
    if any(tok in low for tok in (" get /api/", " post /api/", " get /ws", " put /api/")):
        return None
    if any(m in low for m in _ERROR_MARKERS):
        return "error"
    if any(m in low for m in _WARN_MARKERS):
        return "warn"
    return None


def journal_incident_lines(text: str, *, limit: int = 40) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for line in (text or "").splitlines():
        line = line.rstrip()
        if not line:
            continue
        level = incident_level(line)
        if not level:
            continue
        out.append((level, line[:4000]))
    if len(out) > limit:
        out = out[-limit:]
    return out


def record_event(level: str, message: str) -> None:
    """Append one incident to the ring and to disk (survives process exit)."""
    message = (message or "").strip()
    if not message:
        return
    message = message[:4000]
    level = (level or "error")[:16]
    trace_append(level, message, source="server")
    try:
        EVENTS_PATH.parent.mkdir(parents=True, exist_ok=True)
        prior: list[str] = []
        if EVENTS_PATH.is_file():
            prior = EVENTS_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
        prior.append(json.dumps({"level": level, "message": message}, ensure_ascii=False))
        prior = [ln for ln in prior if ln.strip()][-MAX_EVENTS:]
        EVENTS_PATH.write_text("\n".join(prior) + "\n", encoding="utf-8")
    except OSError as e:
        log.warning("could not persist service event: %s", e)


def replay_events() -> int:
    """Load saved incidents into the ring, then drop the file so they show once."""
    if not EVENTS_PATH.is_file():
        return 0
    try:
        raw = EVENTS_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return 0
    n = 0
    for line in raw[-MAX_EVENTS:]:
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(item, dict):
            continue
        msg = str(item.get("message") or "").strip()
        if not msg:
            continue
        trace_append(str(item.get("level") or "error")[:16], msg, source="server")
        n += 1
    try:
        EVENTS_PATH.unlink()
    except OSError:
        pass
    return n


async def replay_journal() -> int:
    """Pull new journal incidents into the Logs ring. Best-effort."""
    import asyncio

    cmd = [
        "journalctl",
        "-u",
        "homebased.service",
        "-n",
        "80",
        "--no-pager",
        "-o",
        "short-iso",
        "--cursor-file",
        str(CURSOR_PATH),
    ]
    try:
        CURSOR_PATH.parent.mkdir(parents=True, exist_ok=True)
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out_b, _ = await asyncio.wait_for(proc.communicate(), timeout=8.0)
    except Exception as e:
        log.info("journal replay skipped: %s", e)
        return 0
    if proc.returncode not in (0, None):
        return 0
    text = (out_b or b"").decode("utf-8", errors="replace")
    n = 0
    for level, line in journal_incident_lines(text):
        trace_append(level, line, source="journald")
        n += 1
    return n


def install_crash_hooks() -> None:
    """Send fatal traces to stderr (journal) and the durable event file."""
    import faulthandler

    try:
        faulthandler.enable(file=sys.stderr, all_threads=True)
    except Exception:
        pass

    def _hook(exc_type, exc, tb) -> None:
        text = "".join(traceback.format_exception(exc_type, exc, tb))
        try:
            record_event("error", "uncaught exception:\n" + text)
        except Exception:
            pass
        sys.__excepthook__(exc_type, exc, tb)

    sys.excepthook = _hook

    if hasattr(sys, "unraisablehook"):

        def _unraisable(unraisable) -> None:
            text = "".join(
                traceback.format_exception(
                    unraisable.exc_type,
                    unraisable.exc_value,
                    unraisable.exc_traceback,
                )
            )
            try:
                record_event("error", "unraisable exception:\n" + text)
            except Exception:
                pass
            sys.__unraisablehook__(unraisable)

        sys.unraisablehook = _unraisable
