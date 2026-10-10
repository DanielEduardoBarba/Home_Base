"""Join streamed Cursor tokens into one bubble.

The SDK sometimes sends a new piece of text, sometimes resends the whole
reply so far, and sometimes re-sends the last word both bare and with a
leading space ("I" then " I"). These helpers accept all of those shapes.
"""

from __future__ import annotations

import re


def collapse_doubled_tokens(text: str) -> str:
    """Collapse consecutive duplicate tokens: 'I I did did' → 'I did'."""
    if not text or " " not in text and "\n" not in text:
        return text
    return re.sub(r"(\S+)(?:\s+\1)+(?=\s|$)", r"\1", text)


def _ends_with_token(prev: str, token: str) -> bool:
    """True when prev already ends with token as a whole word/token."""
    if not prev or not token:
        return False
    pr = prev.rstrip()
    if not pr.endswith(token):
        return False
    if len(pr) == len(token):
        return True
    before = pr[-len(token) - 1]
    return not (before.isalnum() or before in {"_", "-"})


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
    # Growing cumulative snapshot
    if chunk.startswith(prev):
        return chunk
    # Out-of-order / shorter replay of the same stream
    if prev.startswith(chunk):
        return prev
    # Exact trailing replay (full chunk already at the end)
    if prev.endswith(chunk):
        return prev

    stripped = chunk.lstrip()
    # Duplicate word delta: "did" or " did" when we already have "… did"
    if stripped and "\n" not in stripped and _ends_with_token(prev, stripped):
        # Only skip single-token replays, not multi-word extensions
        if stripped == chunk.strip() and " " not in stripped and "\t" not in stripped:
            return prev

    max_overlap = min(120, len(prev), len(chunk))
    for n in range(max_overlap, 0, -1):
        if prev.endswith(chunk[:n]):
            return prev + chunk[n:]

    return collapse_doubled_tokens(join_thinking_chunk(prev, chunk))


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
            return collapse_doubled_tokens(nxt)
        return collapse_doubled_tokens(prev)
    max_overlap = min(80, len(a), len(b))
    for n in range(max_overlap, 0, -1):
        if a.endswith(b[:n]):
            return collapse_doubled_tokens(a + b[n:])
    if prefer_next:
        sample = a[: min(40, len(a))]
        if len(sample) >= 12 and sample in b and len(b) >= len(a) * 0.5:
            return collapse_doubled_tokens(nxt)
        # Already streamed via deltas — don't append a fragment that would double words
        if b in a or _ends_with_token(a, b.split()[-1] if b.split() else ""):
            return collapse_doubled_tokens(prev)
    return collapse_doubled_tokens(append_stream_chunk(prev, nxt))
