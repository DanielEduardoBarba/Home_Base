"""View helpers — no live X11 required."""
from __future__ import annotations

import struct

from server.view import (
    FRAME_HEADER,
    FRAME_MAGIC,
    _browser_to_keysym,
    _monitor_rect,
    _monitors_payload,
    discover_x11_env,
    display_owner_ids,
)


class _FakeSct:
    def __init__(self, monitors):
        self.monitors = monitors


def test_frame_header_size():
    assert FRAME_HEADER.size == 20
    packed = FRAME_HEADER.pack(FRAME_MAGIC, 7, 1280, 800, 3840, 1200, 1, 55, 0)
    assert len(packed) == 20
    magic, seq, w, h, sw, sh, flags, q, _pad = FRAME_HEADER.unpack(packed)
    assert magic == FRAME_MAGIC
    assert seq == 7
    assert (w, h, sw, sh) == (1280, 800, 3840, 1200)
    assert flags == 1 and q == 55


def test_browser_keysyms():
    assert _browser_to_keysym("a", "KeyA") == "a"
    assert _browser_to_keysym("Enter", "Enter") == "Return"
    assert _browser_to_keysym(" ", "Space") == "space"
    assert _browser_to_keysym("ArrowLeft", "ArrowLeft") == "Left"
    assert _browser_to_keysym("1", "Digit1") == "1"
    assert _browser_to_keysym("F5", "F5") == "F5"


def test_discover_x11_env_returns_display():
    display, xauth = discover_x11_env()
    assert display.startswith(":")
    assert xauth  # hardcoded fallback or env


def test_display_owner_ids():
    uid, gid = display_owner_ids(":0")
    assert uid >= 0
    assert gid >= 0


def test_header_client_offsets_match():
    """Keep in sync with web/src/components/ViewTab.tsx parseHeader."""
    packed = FRAME_HEADER.pack(FRAME_MAGIC, 42, 100, 50, 200, 100, 1, 40, 0)
    v = memoryview(packed)
    assert struct.unpack_from("<I", v, 0)[0] == FRAME_MAGIC
    assert struct.unpack_from("<I", v, 4)[0] == 42
    assert struct.unpack_from("<H", v, 8)[0] == 100
    assert struct.unpack_from("<H", v, 10)[0] == 50
    assert v[17] == 40


def test_monitors_payload_labels():
    sct = _FakeSct(
        [
            {"left": 0, "top": 0, "width": 3840, "height": 1200},
            {"left": 0, "top": 0, "width": 1920, "height": 1200},
            {"left": 1920, "top": 0, "width": 1920, "height": 1200},
        ]
    )
    mons = _monitors_payload(sct)
    assert len(mons) == 3
    assert mons[0]["label"] == "All displays"
    assert mons[1]["label"] == "Display 1"
    assert mons[2]["width"] == 1920
    assert _monitor_rect(sct, 2)["left"] == 1920
    assert _monitor_rect(sct, 99)["width"] == 3840  # invalid → virtual desktop
