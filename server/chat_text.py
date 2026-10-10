"""Join streamed Cursor tokens into one bubble.

The SDK sometimes sends a new piece of text, and sometimes resends the whole
reply so far. These helpers accept both, matching the chat UI.
"""

from __future__ import annotations

import re


def join_thinking_chunk(prev: str, chunk: str) -> str:
    if not chunk:
        return prev
    if not prev:
        return chunk
    if chunk.startswith(prev):
        return chunk
    if prev.startswith(chunk):
        return prev
    if prev[-1].isspace() or chunk[0].isspace():
        return prev + chunk
    if re.match(r"^[.,;:!?…)}\]\"']", chunk):
        return prev + chunk
    if re.search(r"[({\[\"']$", prev):
        return prev + chunk
    if re.search(r"\w$", prev) and re.match(r"\w", chunk):
        return f"{prev} {chunk}"
    return prev + chunk


def append_stream_chunk(prev: str, chunk: str) -> str:
    """Append a delta, or adopt a longer snapshot of the same text."""
    if not chunk:
        return prev
    if not prev:
        return chunk
    if chunk == prev:
        return prev
    if chunk.startswith(prev):
        return chunk
    if prev.startswith(chunk):
        return prev
    max_overlap = min(120, len(prev), len(chunk))
    for n in range(max_overlap, 7, -1):
        if prev.endswith(chunk[:n]):
            return prev + chunk[n:]
    return join_thinking_chunk(prev, chunk)


def merge_assistant_text(prev: str, nxt: str, prefer_next: bool = False) -> str:
    """Merge a later full reply with the text already on screen."""
    if not nxt:
        return prev
    if not prev:
        return nxt
    if prev == nxt:
        return prev
    if nxt.startswith(prev):
        return nxt
    if prev.startswith(nxt):
        return prev

    a = prev.strip()
    b = nxt.strip()
    head = min(48, len(a), len(b))
    if head >= 16 and (a.startswith(b[:head]) or b.startswith(a[:head])):
        if len(nxt) >= len(prev) or (prefer_next and len(nxt) >= len(prev) * 0.85):
            return nxt
        return prev
    max_overlap = min(80, len(a), len(b))
    for n in range(max_overlap, 11, -1):
        if a.endswith(b[:n]):
            return a + b[n:]
    if prefer_next:
        sample = a[: min(40, len(a))]
        if len(sample) >= 12 and sample in b and len(b) >= len(a) * 0.5:
            return nxt
    return append_stream_chunk(prev, nxt)
