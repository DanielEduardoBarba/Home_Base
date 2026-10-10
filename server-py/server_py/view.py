"""JWT-gated remote desktop: X11 capture + input over WebSocket.

homebased runs as root; the user X session only accepts the seat owner.
Nuitka onefile cannot fork safely, so capture/input run in a setpriv
subprocess (`homebase --view-worker`) as the seat UID. Capture runs only
while clients are connected.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import os
import pickle
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("homebase.view")

FRAME_MAGIC = 0x48425646  # 'HBVF'
FRAME_HEADER = struct.Struct("<IIHHHHBBH")  # 20 bytes

DEFAULT_MAX_WIDTH = 1280
DEFAULT_QUALITY = 55
DEFAULT_FPS = 12
MIN_FPS = 4
MAX_FPS = 20
MIN_QUALITY = 28
MAX_QUALITY = 80
MIN_WIDTH = 640
MAX_WIDTH = 1920

_FALLBACK_DISPLAY = ":0"
_FALLBACK_XAUTHORITY = "/home/daniel/.Xauthority"


def discover_x11_env() -> tuple[str, str]:
    """Return (DISPLAY, XAUTHORITY) for the active graphical session."""
    display = (os.environ.get("HOMEBASE_DISPLAY") or os.environ.get("DISPLAY") or "").strip()
    xauth = (os.environ.get("HOMEBASE_XAUTHORITY") or os.environ.get("XAUTHORITY") or "").strip()

    if not display:
        display = _FALLBACK_DISPLAY

    if not xauth:
        xauth = _FALLBACK_XAUTHORITY
    else:
        try:
            if not Path(xauth).is_file():
                xauth = _FALLBACK_XAUTHORITY
        except OSError:
            xauth = _FALLBACK_XAUTHORITY

    return display, xauth


def apply_x11_env() -> tuple[str, str]:
    display, xauth = discover_x11_env()
    os.environ["DISPLAY"] = display
    if xauth:
        os.environ["XAUTHORITY"] = xauth
    return display, xauth


def display_owner_ids(display: str) -> tuple[int, int]:
    """UID/GID that owns the X11 unix socket (the logged-in seat user)."""
    override = (os.environ.get("HOMEBASE_VIEW_UID") or "").strip()
    if override.isdigit():
        uid = int(override)
        try:
            import pwd

            return uid, pwd.getpwuid(uid).pw_gid
        except KeyError:
            return uid, uid

    name = display.lstrip(":").split(".")[0] or "0"
    sock = Path("/tmp/.X11-unix") / f"X{name}"
    try:
        st = sock.stat()
        return int(st.st_uid), int(st.st_gid)
    except OSError:
        pass

    # Fall back to owner of Xauthority file
    _, xauth = discover_x11_env()
    try:
        st = Path(xauth).stat()
        return int(st.st_uid), int(st.st_gid)
    except OSError:
        return os.getuid(), os.getgid()


@dataclass
class ClientState:
    ws: Any
    max_width: int = DEFAULT_MAX_WIDTH
    quality: int = DEFAULT_QUALITY
    fps: int = DEFAULT_FPS
    monitor: int = 0  # 0 = all displays (mss virtual desktop)
    pending: int = 0
    last_ack_seq: int = 0
    last_rtt_ms: float = 0.0
    # True when client sent explicit fps/quality (LAN/VPN presets) — skip auto-adapt.
    user_locked: bool = False
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def _monitors_payload(sct: Any) -> list[dict[str, Any]]:
    """mss index 0 = virtual desktop; 1..n = physical displays."""
    out: list[dict[str, Any]] = []
    mons = getattr(sct, "monitors", None) or []
    for i, m in enumerate(mons):
        try:
            w, h = int(m["width"]), int(m["height"])
            if w <= 0 or h <= 0:
                continue
            label = "All displays" if i == 0 else f"Display {i}"
            out.append(
                {
                    "index": i,
                    "label": label,
                    "left": int(m["left"]),
                    "top": int(m["top"]),
                    "width": w,
                    "height": h,
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    return out


def _monitor_rect(sct: Any, index: int) -> dict[str, int]:
    mons = getattr(sct, "monitors", None) or []
    if not mons:
        return {"left": 0, "top": 0, "width": 0, "height": 0}
    if index < 0 or index >= len(mons):
        index = 0
    m = mons[index]
    return {
        "left": int(m["left"]),
        "top": int(m["top"]),
        "width": int(m["width"]),
        "height": int(m["height"]),
    }


class _XInput:
    """Minimal X11 pointer/keyboard injection via libX11 + libXtst."""

    def __init__(self) -> None:
        self._dpy: Any = None
        self._screen = 0
        self._width = 0
        self._height = 0
        self._desk_left = 0
        self._desk_top = 0
        self._X: Any = None
        self._Xtst: Any = None
        self._keysym_cache: dict[str, int] = {}
        self._err = ""

    @property
    def error(self) -> str:
        return self._err

    @property
    def size(self) -> tuple[int, int]:
        return self._width, self._height

    def open(self) -> bool:
        if self._dpy:
            return True
        try:
            from ctypes import CDLL, c_char_p, c_int, c_uint, c_ulong, c_void_p

            apply_x11_env()
            X = CDLL("libX11.so.6")
            Xtst = CDLL("libXtst.so.6")
            X.XOpenDisplay.restype = c_void_p
            X.XOpenDisplay.argtypes = [c_char_p]
            dpy = X.XOpenDisplay(None)
            if not dpy:
                self._err = f"Cannot open X display {os.environ.get('DISPLAY', '?')}"
                return False
            X.XDefaultScreen.argtypes = [c_void_p]
            X.XDefaultScreen.restype = c_int
            X.XDisplayWidth.argtypes = [c_void_p, c_int]
            X.XDisplayWidth.restype = c_int
            X.XDisplayHeight.argtypes = [c_void_p, c_int]
            X.XDisplayHeight.restype = c_int
            X.XFlush.argtypes = [c_void_p]
            X.XCloseDisplay.argtypes = [c_void_p]
            X.XStringToKeysym.argtypes = [c_char_p]
            X.XStringToKeysym.restype = c_ulong
            X.XKeysymToKeycode.argtypes = [c_void_p, c_ulong]
            X.XKeysymToKeycode.restype = c_int
            Xtst.XTestFakeMotionEvent.argtypes = [c_void_p, c_int, c_int, c_int, c_ulong]
            Xtst.XTestFakeRelativeMotionEvent.argtypes = [c_void_p, c_int, c_int, c_ulong]
            Xtst.XTestFakeButtonEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]
            Xtst.XTestFakeKeyEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]
            X.XDefaultRootWindow.argtypes = [c_void_p]
            X.XDefaultRootWindow.restype = c_ulong
            from ctypes import POINTER, c_uint

            X.XQueryPointer.argtypes = [
                c_void_p,
                c_ulong,
                POINTER(c_ulong),
                POINTER(c_ulong),
                POINTER(c_int),
                POINTER(c_int),
                POINTER(c_int),
                POINTER(c_int),
                POINTER(c_uint),
            ]
            X.XQueryPointer.restype = c_int

            screen = X.XDefaultScreen(dpy)
            self._X = X
            self._Xtst = Xtst
            self._dpy = dpy
            self._screen = screen
            self._width = X.XDisplayWidth(dpy, screen)
            self._height = X.XDisplayHeight(dpy, screen)
            self._err = ""
            return True
        except Exception as e:
            self._err = str(e)
            return False

    def close(self) -> None:
        if self._dpy and self._X:
            try:
                self._X.XCloseDisplay(self._dpy)
            except Exception:
                pass
        self._dpy = None

    def refresh_size(self) -> tuple[int, int]:
        if not self._dpy and not self.open():
            return 0, 0
        self._width = self._X.XDisplayWidth(self._dpy, self._screen)
        self._height = self._X.XDisplayHeight(self._dpy, self._screen)
        return self._width, self._height

    def motion(self, x: int, y: int) -> None:
        if not self._dpy and not self.open():
            return
        # Soft clamp to virtual desktop. Origin may be negative (monitor left of primary).
        x, y = int(x), int(y)
        left = getattr(self, "_desk_left", 0) or 0
        top = getattr(self, "_desk_top", 0) or 0
        width = self._width or 0
        height = self._height or 0
        if width > 0 and height > 0:
            x = max(left, min(left + width - 1, x))
            y = max(top, min(top + height - 1, y))
        self._Xtst.XTestFakeMotionEvent(self._dpy, self._screen, x, y, 0)
        self._X.XFlush(self._dpy)

    def relative_motion(self, dx: int, dy: int) -> None:
        if not self._dpy and not self.open():
            return
        dx, dy = int(dx), int(dy)
        if dx == 0 and dy == 0:
            return
        self._Xtst.XTestFakeRelativeMotionEvent(self._dpy, dx, dy, 0)
        self._X.XFlush(self._dpy)

    def query_pointer(self) -> tuple[int, int]:
        """Root-window pointer position, or (-1, -1) on failure."""
        if not self._dpy and not self.open():
            return -1, -1
        try:
            from ctypes import byref, c_int, c_uint, c_ulong

            root = self._X.XDefaultRootWindow(self._dpy)
            root_ret = c_ulong()
            child = c_ulong()
            root_x = c_int()
            root_y = c_int()
            win_x = c_int()
            win_y = c_int()
            mask = c_uint()
            ok = self._X.XQueryPointer(
                self._dpy,
                root,
                byref(root_ret),
                byref(child),
                byref(root_x),
                byref(root_y),
                byref(win_x),
                byref(win_y),
                byref(mask),
            )
            if not ok:
                return -1, -1
            return int(root_x.value), int(root_y.value)
        except Exception:
            return -1, -1

    def button(self, button: int, pressed: bool) -> None:
        if not self._dpy and not self.open():
            return
        self._Xtst.XTestFakeButtonEvent(self._dpy, int(button), 1 if pressed else 0, 0)
        self._X.XFlush(self._dpy)

    def wheel(self, delta_y: float) -> None:
        steps = max(1, min(8, int(abs(delta_y) / 40) or 1))
        button = 4 if delta_y < 0 else 5
        for _ in range(steps):
            self.button(button, True)
            self.button(button, False)

    def _keysym(self, name: str) -> int:
        cached = self._keysym_cache.get(name)
        if cached is not None:
            return cached
        sym = int(self._X.XStringToKeysym(name.encode("utf-8")))
        self._keysym_cache[name] = sym
        return sym

    def key(self, key: str, code: str, pressed: bool) -> None:
        if not self._dpy and not self.open():
            return
        keysym_name = _browser_to_keysym(key, code)
        if not keysym_name:
            return
        sym = self._keysym(keysym_name)
        if not sym:
            return
        keycode = self._X.XKeysymToKeycode(self._dpy, sym)
        if not keycode:
            return
        self._Xtst.XTestFakeKeyEvent(self._dpy, keycode, 1 if pressed else 0, 0)
        self._X.XFlush(self._dpy)


_KEY_CODE_MAP = {
    "Enter": "Return",
    "Escape": "Escape",
    "Backspace": "BackSpace",
    "Tab": "Tab",
    "Space": "space",
    "ArrowLeft": "Left",
    "ArrowRight": "Right",
    "ArrowUp": "Up",
    "ArrowDown": "Down",
    "Home": "Home",
    "End": "End",
    "PageUp": "Page_Up",
    "PageDown": "Page_Down",
    "Delete": "Delete",
    "Insert": "Insert",
    "ShiftLeft": "Shift_L",
    "ShiftRight": "Shift_R",
    "ControlLeft": "Control_L",
    "ControlRight": "Control_R",
    "AltLeft": "Alt_L",
    "AltRight": "Alt_R",
    "MetaLeft": "Super_L",
    "MetaRight": "Super_R",
    "CapsLock": "Caps_Lock",
    "Minus": "minus",
    "Equal": "equal",
    "BracketLeft": "bracketleft",
    "BracketRight": "bracketright",
    "Backslash": "backslash",
    "Semicolon": "semicolon",
    "Quote": "apostrophe",
    "Backquote": "grave",
    "Comma": "comma",
    "Period": "period",
    "Slash": "slash",
}


def _browser_to_keysym(key: str, code: str) -> Optional[str]:
    if code in _KEY_CODE_MAP:
        return _KEY_CODE_MAP[code]
    if code.startswith("Key") and len(code) == 4:
        return code[-1].lower()
    if code.startswith("Digit") and len(code) == 6:
        return code[-1]
    if code.startswith("Numpad") and code[-1:].isdigit():
        return f"KP_{code[-1]}"
    if code.startswith("F") and code[1:].isdigit():
        return code
    if len(key) == 1:
        ch = key
        if ch.isalpha():
            return ch.lower()
        table = {
            " ": "space",
            "-": "minus",
            "=": "equal",
            "[": "bracketleft",
            "]": "bracketright",
            "\\": "backslash",
            ";": "semicolon",
            "'": "apostrophe",
            "`": "grave",
            ",": "comma",
            ".": "period",
            "/": "slash",
        }
        return table.get(ch)
    return None


_MSG_HDR = struct.Struct(">I")


def _view_json_mode() -> bool:
    return (os.environ.get("HOMEBASE_VIEW_JSON") or "").strip() in {"1", "true", "yes"}


def _send_msg(out: Any, obj: Any) -> None:
    if _view_json_mode():
        import base64
        import json as _json

        payload = dict(obj) if isinstance(obj, dict) else {"ok": False, "error": "bad obj"}
        pkt = payload.get("packet")
        if isinstance(pkt, (bytes, bytearray)):
            payload = {**payload, "packet": base64.b64encode(bytes(pkt)).decode("ascii")}
            payload["packetEncoding"] = "base64"
        data = _json.dumps(payload, separators=(",", ":")).encode("utf-8")
        out.write(_MSG_HDR.pack(len(data)))
        out.write(data)
        out.flush()
        return
    data = pickle.dumps(obj, protocol=pickle.HIGHEST_PROTOCOL)
    out.write(_MSG_HDR.pack(len(data)))
    out.write(data)
    out.flush()


def _recv_msg(inp: Any) -> Any:
    hdr = inp.read(_MSG_HDR.size)
    if not hdr or len(hdr) < _MSG_HDR.size:
        raise EOFError("worker closed")
    (n,) = _MSG_HDR.unpack(hdr)
    if n <= 0 or n > 64 * 1024 * 1024:
        raise ValueError(f"bad worker message size {n}")
    data = inp.read(n)
    if len(data) < n:
        raise EOFError("worker closed mid-message")
    if _view_json_mode():
        import base64
        import json as _json

        obj = _json.loads(data.decode("utf-8"))
        if isinstance(obj, dict) and obj.get("packetEncoding") == "base64" and isinstance(
            obj.get("packet"), str
        ):
            obj["packet"] = base64.b64decode(obj["packet"])
        return obj
    return pickle.loads(data)


def _grab_jpeg(
    sct: Any,
    encode_buf: io.BytesIO,
    last_hash: bytes,
    max_width: int,
    quality: int,
    monitor: int = 0,
) -> tuple[bytes, int, int, bool, bytes]:
    from PIL import Image

    rect = _monitor_rect(sct, int(monitor))
    sw, sh = rect["width"], rect["height"]
    if sw <= 0 or sh <= 0:
        raise RuntimeError("no monitors")
    mon = {
        "left": rect["left"],
        "top": rect["top"],
        "width": sw,
        "height": sh,
    }
    shot = sct.grab(mon)
    bgra = bytes(shot.raw)
    size = shot.size
    im = Image.frombytes("RGB", size, bgra, "raw", "BGRX")
    del bgra

    if im.width > max_width:
        nh = max(1, int(im.height * (max_width / im.width)))
        resized = im.resize((max_width, nh), Image.Resampling.BILINEAR)
        im.close()
        im = resized

    sample = im.resize((48, max(1, int(48 * im.height / im.width))), Image.Resampling.NEAREST)
    digest = hashlib.md5(sample.tobytes(), usedforsecurity=False).digest()
    sample.close()
    if digest == last_hash:
        im.close()
        return b"", sw, sh, False, last_hash

    encode_buf.seek(0)
    encode_buf.truncate(0)
    im.save(encode_buf, format="JPEG", quality=int(quality), optimize=False, subsampling=2)
    payload = encode_buf.getvalue()
    fw, fh = im.size
    im.close()

    header = FRAME_HEADER.pack(FRAME_MAGIC, 0, fw, fh, sw, sh, 1, int(quality), 0)
    return header + payload, sw, sh, True, digest


def _dispatch_worker_cmd(
    msg: dict[str, Any],
    *,
    xin: _XInput,
    sct_holder: list[Any],
    encode_buf: io.BytesIO,
    last_hash_holder: list[bytes],
) -> dict[str, Any]:
    """Handle one worker command; returns response dict (may include packet bytes)."""
    import mss

    cmd = msg.get("cmd")
    if cmd == "stop":
        return {"ok": True, "stop": True}
    if cmd == "ping":
        ok = xin.open()
        w, h = xin.refresh_size() if ok else (0, 0)
        monitors: list[dict[str, Any]] = []
        cx = cy = -1
        try:
            if sct_holder[0] is None:
                sct_holder[0] = mss.mss()
            monitors = _monitors_payload(sct_holder[0])
            if not ok and monitors:
                w, h = monitors[0]["width"], monitors[0]["height"]
                ok = w > 0
        except Exception as e:
            if not ok:
                return {"ok": False, "error": str(e) or xin.error}
        if ok:
            cx, cy = xin.query_pointer()
        return {
            "ok": ok,
            "screenW": w,
            "screenH": h,
            "monitors": monitors,
            "cursorX": cx,
            "cursorY": cy,
            "uid": os.getuid(),
            "error": "" if ok else xin.error,
        }
    if cmd == "grab":
        try:
            if sct_holder[0] is None:
                sct_holder[0] = mss.mss()
            packet, sw, sh, changed, digest = _grab_jpeg(
                sct_holder[0],
                encode_buf,
                last_hash_holder[0],
                int(msg.get("maxWidth") or DEFAULT_MAX_WIDTH),
                int(msg.get("quality") or DEFAULT_QUALITY),
                int(msg.get("monitor") or 0),
            )
            last_hash_holder[0] = digest
            return {
                "ok": True,
                "packet": packet,
                "sw": sw,
                "sh": sh,
                "changed": changed,
                "monitors": _monitors_payload(sct_holder[0]),
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if cmd == "pointer":
        try:
            xin.open()
            if sct_holder[0] is None:
                sct_holder[0] = mss.mss()
            mode = str(msg.get("mode") or "abs")
            action = str(msg.get("action") or "")
            if mode == "rel" or action == "relmove":
                dx = int(round(float(msg.get("dx") or 0)))
                dy = int(round(float(msg.get("dy") or 0)))
                if action in ("move", "relmove") or (action in ("down", "up", "wheel") and (dx or dy)):
                    if dx or dy:
                        xin.relative_motion(dx, dy)
                # Relative clicks act at the current cursor — do not warp.
            else:
                rect = _monitor_rect(sct_holder[0], int(msg.get("monitor") or 0))
                mw, mh = rect["width"], rect["height"]
                if mw <= 0 or mh <= 0:
                    xin.refresh_size()
                    mw, mh = xin.size
                    rect = {"left": 0, "top": 0, "width": mw, "height": mh}
                # Keep motion clamp aligned with virtual desktop (may be negative origin).
                try:
                    desk = _monitor_rect(sct_holder[0], 0)
                    xin._desk_left = int(desk.get("left") or 0)
                    xin._desk_top = int(desk.get("top") or 0)
                    if desk.get("width"):
                        xin._width = int(desk["width"])
                    if desk.get("height"):
                        xin._height = int(desk["height"])
                except Exception:
                    pass
                nx = float(msg.get("x") or 0)
                ny = float(msg.get("y") or 0)
                x = int(rect["left"] + nx * mw)
                y = int(rect["top"] + ny * mh)
                if action in ("move", "down", "up", "wheel"):
                    xin.motion(x, y)
            if action == "down":
                xin.button(_dom_button_to_x(int(msg.get("button") or 0)), True)
            elif action == "up":
                xin.button(_dom_button_to_x(int(msg.get("button") or 0)), False)
            elif action == "click":
                btn = _dom_button_to_x(int(msg.get("button") or 0))
                xin.button(btn, True)
                xin.button(btn, False)
            elif action == "wheel":
                dy = float(msg.get("deltaY") or 0)
                if dy:
                    xin.wheel(dy)
            cx, cy = xin.query_pointer()
            return {"ok": True, "cursorX": cx, "cursorY": cy}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if cmd == "key":
        try:
            xin.open()
            action = str(msg.get("action") or "")
            key = str(msg.get("key") or "")
            code = str(msg.get("code") or "")
            if action == "down":
                xin.key(key, code, True)
            elif action == "up":
                xin.key(key, code, False)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    return {"ok": False, "error": f"unknown cmd {cmd}"}


def run_view_worker() -> int:
    """Entry for `homebase --view-worker` (already running as seat user via setpriv)."""
    apply_x11_env()
    inp = sys.stdin.buffer
    out = sys.stdout.buffer

    xin = _XInput()
    sct_holder: list[Any] = [None]
    encode_buf = io.BytesIO()
    last_hash_holder: list[bytes] = [b""]
    last_monitor_holder: list[int] = [0]

    print(
        f"view-worker ready uid={os.getuid()} display={os.environ.get('DISPLAY')} "
        f"xauth={os.environ.get('XAUTHORITY')}",
        file=sys.stderr,
        flush=True,
    )
    try:
        while True:
            try:
                msg = _recv_msg(inp)
            except EOFError:
                break
            if not isinstance(msg, dict):
                continue
            if msg.get("cmd") == "grab":
                mon = int(msg.get("monitor") or 0)
                if mon != last_monitor_holder[0]:
                    last_hash_holder[0] = b""
                    last_monitor_holder[0] = mon
            resp = _dispatch_worker_cmd(
                msg,
                xin=xin,
                sct_holder=sct_holder,
                encode_buf=encode_buf,
                last_hash_holder=last_hash_holder,
            )
            stop = bool(resp.pop("stop", False))
            _send_msg(out, resp)
            if stop:
                break
    except Exception as e:
        try:
            _send_msg(out, {"ok": False, "error": f"worker crash: {e}"})
        except Exception:
            print(f"view-worker crash: {e}", file=sys.stderr, flush=True)
        return 1
    finally:
        try:
            xin.close()
        except BaseException:
            pass
        if sct_holder[0] is not None:
            try:
                # Parent terminate/SIGINT can raise KeyboardInterrupt inside mss/xcb.
                sct_holder[0].close()
            except BaseException:
                pass
    return 0


def _is_elf_binary(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(4).startswith(b"\x7fELF")
    except OSError:
        return False


def _resolve_worker_inner_cmd() -> list[str]:
    """Command that enters --view-worker (no setpriv yet)."""
    here = Path(__file__).resolve()
    entry = here.parents[1] / "homebase_entry.py"
    # Source checkout (has build.sh) → use this tree + venv so deps (mss) resolve.
    if entry.is_file() and (entry.parent / "build.sh").is_file():
        venv_py = entry.parent / ".venv" / "bin" / "python"
        py = str(venv_py) if venv_py.is_file() else sys.executable
        return [py, str(entry), "--view-worker"]

    share = os.environ.get("HOMEBASE_SHARE", "/usr/share/homebased").rstrip("/")
    argv0 = os.path.realpath(sys.argv[0]) if sys.argv else ""
    for cand in (argv0, f"{share}/homebase", "/usr/share/homebased/homebase", os.environ.get("HOMEBASE_BIN", "")):
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK) and _is_elf_binary(cand):
            return [cand, "--view-worker"]

    if entry.is_file():
        return [sys.executable, str(entry), "--view-worker"]
    return [
        sys.executable,
        "-c",
        "from server.view import run_view_worker; raise SystemExit(run_view_worker())",
    ]


def _seat_scratch_home(uid: int, gid: int) -> str:
    """Writable HOMEBASE_HOME for the seat-user view worker (avoids root-only /var/lib)."""
    path = Path(f"/tmp/homebase-view-{uid}")
    try:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        if os.geteuid() == 0:
            os.chown(path, uid, gid)
            os.chmod(path, 0o700)
    except OSError:
        path = Path(tempfile.gettempdir()) / f"homebase-view-{uid}"
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            if os.geteuid() == 0:
                os.chown(path, uid, gid)
        except OSError:
            pass
    return str(path)


def _build_worker_cmd(uid: int, gid: int) -> tuple[list[str], dict[str, str]]:
    import pwd

    display, xauth = discover_x11_env()
    pw = pwd.getpwuid(uid)
    env = os.environ.copy()
    env["DISPLAY"] = display
    env["XAUTHORITY"] = xauth
    env["HOME"] = pw.pw_dir
    env["USER"] = pw.pw_name
    env["LOGNAME"] = pw.pw_name
    env.pop("HOMEBASE_SELF_TEST", None)
    env["HOMEBASE_VIEW_WORKER"] = "1"
    # systemd sets HOMEBASE_HOME=/var/lib/homebased (.env mode 0600 root). The worker
    # drops to the seat UID and must not inherit that path or config import dies.
    scratch = _seat_scratch_home(uid, gid)
    env["HOMEBASE_HOME"] = scratch
    env["HOMEBASE_RUNTIME"] = str(Path(scratch) / ".runtime")
    env["TMPDIR"] = scratch

    inner = _resolve_worker_inner_cmd()
    if os.geteuid() == 0 and uid != 0:
        setpriv = shutil.which("setpriv")
        if setpriv:
            # Root→seat user. --init-groups required with --regid (do not also pass --clear-groups).
            cmd = [
                setpriv,
                f"--reuid={uid}",
                f"--regid={gid}",
                "--init-groups",
                "--",
                *inner,
            ]
        else:
            runuser = shutil.which("runuser")
            if not runuser:
                raise RuntimeError("setpriv/runuser required for View as root")
            cmd = [runuser, "-u", pw.pw_name, "--", *inner]
    else:
        cmd = inner
    return cmd, env


class _X11Bridge:
    """Parent-side handle to the setpriv --view-worker subprocess."""

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._lock = asyncio.Lock()
        self._io_lock = threading.Lock()
        self.screen_w = 0
        self.screen_h = 0
        self.monitors: list[dict[str, Any]] = []
        self.uid = -1
        self.last_error = ""
        self._stderr_tail: list[str] = []

    @property
    def alive(self) -> bool:
        return bool(self._proc and self._proc.poll() is None and self._proc.stdin and self._proc.stdout)

    def _note_stderr(self, text: str) -> None:
        line = text.strip()
        if not line:
            return
        self._stderr_tail.append(line)
        if len(self._stderr_tail) > 12:
            self._stderr_tail = self._stderr_tail[-12:]

    def _stderr_hint(self) -> str:
        if not self._stderr_tail:
            return ""
        # Prefer the last non-ready line (ready is normal).
        for line in reversed(self._stderr_tail):
            if "view-worker ready" in line:
                continue
            return line[:240]
        return self._stderr_tail[-1][:240]

    def start(self) -> None:
        if self.alive:
            return
        self.stop()
        self._stderr_tail = []
        display, xauth = discover_x11_env()
        uid, gid = display_owner_ids(display)
        cmd, env = _build_worker_cmd(uid, gid)
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            bufsize=0,
        )
        self._proc = proc
        self.uid = uid

        def _drain_stderr() -> None:
            assert proc.stderr is not None
            try:
                for line in iter(proc.stderr.readline, b""):
                    text = line.decode("utf-8", errors="replace").rstrip()
                    if text:
                        self._note_stderr(text)
                        log.info("view-worker: %s", text)
            except Exception:
                pass

        threading.Thread(target=_drain_stderr, name="view-worker-err", daemon=True).start()
        log.info(
            "view X11 worker started cmd=%s display=%s uid=%s xauth=%s",
            cmd[:3],
            display,
            uid,
            xauth,
        )
        # Warm ping — if the child dies immediately, surface stderr (e.g. .env perms).
        resp = self._call({"cmd": "ping"}, timeout=6.0, _restarting=True)
        if not resp.get("ok"):
            err = str(resp.get("error") or self.last_error or "worker ping failed")
            hint = self._stderr_hint()
            if hint and hint not in err:
                err = f"{err} ({hint})"
            self.last_error = err
            log.warning("view worker ping failed: %s", err)

    def stop(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None:
            return
        try:
            if proc.poll() is None and proc.stdin:
                with self._io_lock:
                    try:
                        _send_msg(proc.stdin, {"cmd": "stop"})
                    except Exception:
                        pass
        except Exception:
            pass
        try:
            proc.terminate()
        except Exception:
            pass
        try:
            proc.wait(timeout=2.0)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    def _call(
        self, msg: dict[str, Any], timeout: float = 5.0, *, _restarting: bool = False
    ) -> dict[str, Any]:
        if not self.alive:
            if _restarting:
                # start() already in progress
                pass
            else:
                self.start()
        proc = self._proc
        if proc is None or proc.stdin is None or proc.stdout is None or proc.poll() is not None:
            self.last_error = "X11 worker not running"
            return {"ok": False, "error": self.last_error}
        with self._io_lock:
            try:
                _send_msg(proc.stdin, msg)
            except Exception as e:
                self.last_error = f"worker write failed: {e}"
                self.stop()
                return {"ok": False, "error": self.last_error}
            # Blocking read with crude timeout via poll loop
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    hint = self._stderr_hint()
                    base = f"X11 worker exited (code {proc.returncode})"
                    self.last_error = f"{base}: {hint}" if hint else base
                    self.stop()
                    return {"ok": False, "error": self.last_error}
                # stdout is unbuffered binary; use short select
                import select

                r, _, _ = select.select([proc.stdout], [], [], 0.1)
                if not r:
                    continue
                try:
                    resp = _recv_msg(proc.stdout)
                except Exception as e:
                    self.last_error = f"X11 worker exited: {e}"
                    self.stop()
                    return {"ok": False, "error": self.last_error}
                if not isinstance(resp, dict):
                    return {"ok": False, "error": "bad worker response"}
                if not resp.get("ok"):
                    self.last_error = str(resp.get("error") or "X11 error")
                return resp
            self.last_error = "X11 worker timeout"
            self.stop()
            return {"ok": False, "error": self.last_error}

    async def call(self, msg: dict[str, Any], timeout: float = 5.0) -> dict[str, Any]:
        async with self._lock:
            return await asyncio.to_thread(self._call, msg, timeout)


class ViewHub:
    def __init__(self) -> None:
        self._clients: dict[int, ClientState] = {}
        self._lock = asyncio.Lock()
        self._loop_task: Optional[asyncio.Task[None]] = None
        self._seq = 0
        self._bridge = _X11Bridge()
        self._stats = {"fps": 0.0, "kbps": 0.0, "clients": 0}
        self._bytes_window = 0
        self._frames_window = 0
        self._window_t0 = time.monotonic()
        self._last_err_sent = ""

    def status(self) -> dict[str, Any]:
        display, xauth = discover_x11_env()
        uid, gid = display_owner_ids(display)
        ok = False
        err = ""
        sw = sh = 0
        # Never tear down a live capture from a status probe (race with connect).
        streaming = bool(self._clients) or (
            self._loop_task is not None and not self._loop_task.done()
        )
        try:
            self._bridge.start()
            resp = self._bridge._call({"cmd": "ping"}, timeout=4.0)
            ok = bool(resp.get("ok"))
            sw = int(resp.get("screenW") or 0)
            sh = int(resp.get("screenH") or 0)
            err = "" if ok else str(resp.get("error") or self._bridge.last_error)
            if sw:
                self._bridge.screen_w, self._bridge.screen_h = sw, sh
            self._bridge.monitors = list(resp.get("monitors") or [])
        except Exception as e:
            err = str(e)
        if not streaming and not self._clients:
            # Re-check idle: a connect may have raced in during ping.
            if not self._clients and (
                self._loop_task is None or self._loop_task.done()
            ):
                self._bridge.stop()
        return {
            "ok": ok,
            "display": display,
            "xauthority": bool(xauth and Path(xauth).is_file()),
            "screenW": sw,
            "screenH": sh,
            "monitors": self._bridge.monitors,
            "viewUid": uid,
            "viewGid": gid,
            "clients": len(self._clients),
            "error": err,
            **self._stats,
        }

    async def connect(self, ws: Any) -> ClientState:
        client = ClientState(ws=ws)
        async with self._lock:
            self._clients[id(ws)] = client
            if not self._loop_task or self._loop_task.done():
                self._loop_task = asyncio.create_task(self._capture_loop(), name="view-capture")
        cursor_x = cursor_y = -1
        try:
            self._bridge.start()
            resp = await self._bridge.call({"cmd": "ping"})
            if resp.get("ok"):
                self._bridge.screen_w = int(resp.get("screenW") or 0)
                self._bridge.screen_h = int(resp.get("screenH") or 0)
                self._bridge.monitors = list(resp.get("monitors") or [])
                cursor_x = int(resp.get("cursorX") if resp.get("cursorX") is not None else -1)
                cursor_y = int(resp.get("cursorY") if resp.get("cursorY") is not None else -1)
            else:
                await ws.send_json(
                    {"type": "error", "error": resp.get("error") or "Cannot open display"}
                )
        except Exception as e:
            await ws.send_json({"type": "error", "error": str(e)})
        await ws.send_json(
            {
                "type": "hello",
                "screenW": self._bridge.screen_w,
                "screenH": self._bridge.screen_h,
                "monitors": self._bridge.monitors,
                "monitor": client.monitor,
                "cursorX": cursor_x,
                "cursorY": cursor_y,
                "maxWidth": client.max_width,
                "quality": client.quality,
                "fps": client.fps,
                "display": discover_x11_env()[0],
                "viewUid": self._bridge.uid,
            }
        )
        return client

    async def disconnect(self, ws: Any) -> None:
        async with self._lock:
            self._clients.pop(id(ws), None)
            empty = not self._clients
        # Best-effort release stuck remote buttons/keys for this session.
        try:
            await self._bridge.call({"cmd": "pointer", "mode": "rel", "action": "up", "button": 0}, timeout=1.0)
            await self._bridge.call({"cmd": "pointer", "mode": "rel", "action": "up", "button": 1}, timeout=1.0)
            await self._bridge.call({"cmd": "pointer", "mode": "rel", "action": "up", "button": 2}, timeout=1.0)
        except Exception:
            pass
        if empty:
            task = self._loop_task
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception:
                    pass
            self._loop_task = None
            self._bridge.stop()
            self._last_err_sent = ""

    def shutdown(self) -> None:
        task = self._loop_task
        if task and not task.done():
            task.cancel()
        self._loop_task = None
        self._clients.clear()
        self._bridge.stop()

    async def handle_message(self, client: ClientState, msg: dict[str, Any]) -> None:
        mtype = msg.get("type")
        if mtype == "ping":
            await client.ws.send_json({"type": "pong"})
            return
        if mtype == "ack":
            try:
                seq = int(msg.get("seq") or 0)
            except (TypeError, ValueError):
                return
            # Ignore duplicate / out-of-order acks so pending cannot desync.
            if seq and seq <= client.last_ack_seq:
                return
            if seq:
                client.last_ack_seq = seq
            client.pending = max(0, client.pending - 1)
            try:
                client.last_rtt_ms = float(msg.get("rttMs") or 0)
            except (TypeError, ValueError):
                pass
            self._adapt(client)
            return
        if mtype == "config":
            if msg.get("maxWidth") is not None:
                client.max_width = _clamp(int(msg.get("maxWidth") or client.max_width), MIN_WIDTH, MAX_WIDTH)
            if msg.get("quality") is not None:
                client.quality = _clamp(int(msg.get("quality") or client.quality), MIN_QUALITY, MAX_QUALITY)
                client.user_locked = True
            if msg.get("fps") is not None:
                client.fps = _clamp(int(msg.get("fps") or client.fps), MIN_FPS, MAX_FPS)
                client.user_locked = True
            if msg.get("monitor") is not None:
                try:
                    client.monitor = max(0, int(msg.get("monitor")))
                except (TypeError, ValueError):
                    pass
            await client.ws.send_json(
                {
                    "type": "config",
                    "maxWidth": client.max_width,
                    "quality": client.quality,
                    "fps": client.fps,
                    "monitor": client.monitor,
                    "monitors": self._bridge.monitors,
                }
            )
            return
        if mtype == "pointer":
            await self._bridge.call(
                {
                    "cmd": "pointer",
                    "action": msg.get("action"),
                    "mode": msg.get("mode") or "abs",
                    "x": msg.get("x"),
                    "y": msg.get("y"),
                    "dx": msg.get("dx"),
                    "dy": msg.get("dy"),
                    "button": msg.get("button"),
                    "deltaY": msg.get("deltaY"),
                    "monitor": client.monitor,
                },
                timeout=2.0,
            )
            return
        if mtype == "key":
            await self._bridge.call(
                {
                    "cmd": "key",
                    "action": msg.get("action"),
                    "key": msg.get("key"),
                    "code": msg.get("code"),
                },
                timeout=2.0,
            )
            return

    def _adapt(self, client: ClientState) -> None:
        # Respect explicit LAN/VPN presets — only auto-tune the "auto" path.
        if client.user_locked:
            return
        if client.pending >= 3:
            client.quality = max(MIN_QUALITY, client.quality - 6)
            client.fps = max(MIN_FPS, client.fps - 2)
            if client.max_width > MIN_WIDTH + 80:
                client.max_width = max(MIN_WIDTH, client.max_width - 160)
        elif client.pending <= 1 and client.last_rtt_ms and client.last_rtt_ms < 40:
            client.quality = min(MAX_QUALITY, client.quality + 2)
            client.fps = min(MAX_FPS, client.fps + 1)
        elif client.last_rtt_ms and client.last_rtt_ms > 180:
            client.quality = max(MIN_QUALITY, client.quality - 4)
            client.fps = max(MIN_FPS, client.fps - 1)

    async def _capture_loop(self) -> None:
        display, _ = discover_x11_env()
        log.info("view capture started display=%s", display)
        try:
            self._bridge.start()
            while True:
                async with self._lock:
                    clients = list(self._clients.values())
                if not clients:
                    return

                active = [c for c in clients if c.pending < 3]
                if not active:
                    await asyncio.sleep(0.05)
                    continue
                max_width = max(c.max_width for c in active)
                quality = max(c.quality for c in active)
                fps = max(c.fps for c in active)
                mon_set = {c.monitor for c in active}
                monitor = next(iter(mon_set)) if len(mon_set) == 1 else 0
                interval = 1.0 / max(MIN_FPS, min(MAX_FPS, fps))

                t0 = time.monotonic()
                try:
                    resp = await self._bridge.call(
                        {
                            "cmd": "grab",
                            "maxWidth": max_width,
                            "quality": quality,
                            "monitor": monitor,
                        },
                        timeout=3.0,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    await self._emit_error(clients, str(e))
                    await asyncio.sleep(1.5)
                    continue

                if not resp.get("ok"):
                    await self._emit_error(clients, str(resp.get("error") or "capture failed"))
                    await asyncio.sleep(1.5)
                    continue

                sw = int(resp.get("sw") or 0)
                sh = int(resp.get("sh") or 0)
                if sw:
                    self._bridge.screen_w, self._bridge.screen_h = sw, sh
                if resp.get("monitors"):
                    self._bridge.monitors = list(resp.get("monitors") or [])

                packet = resp.get("packet") or b""
                changed = bool(resp.get("changed"))
                if packet and changed:
                    self._seq += 1
                    body = bytearray(packet)
                    struct.pack_into("<I", body, 4, self._seq)
                    data = bytes(body)
                    await asyncio.gather(
                        *[self._send_frame(c, data) for c in active],
                        return_exceptions=True,
                    )
                    self._bytes_window += len(data) * len(active)
                    self._frames_window += 1
                    self._last_err_sent = ""

                now = time.monotonic()
                if now - self._window_t0 >= 1.0:
                    dt = now - self._window_t0
                    self._stats = {
                        "fps": self._frames_window / dt,
                        "kbps": (self._bytes_window * 8 / 1000) / dt,
                        "clients": len(clients),
                    }
                    self._frames_window = 0
                    self._bytes_window = 0
                    self._window_t0 = now

                elapsed = time.monotonic() - t0
                await asyncio.sleep(max(0.0, interval - elapsed))
        except asyncio.CancelledError:
            log.info("view capture stopped")
            raise
        finally:
            if not self._clients:
                self._bridge.stop()

    async def _emit_error(self, clients: list[ClientState], err: str) -> None:
        log.warning("view capture error: %s", err)
        if err == self._last_err_sent:
            return
        self._last_err_sent = err
        for c in clients:
            try:
                await c.ws.send_json({"type": "error", "error": err})
            except Exception:
                pass

    async def _send_frame(self, client: ClientState, data: bytes) -> None:
        async with client.send_lock:
            try:
                await client.ws.send_bytes(data)
                client.pending += 1
            except Exception:
                pass


def _dom_button_to_x(button: int) -> int:
    if button == 1:
        return 2
    if button == 2:
        return 3
    return 1


def _clamp(n: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, n))


view_hub = ViewHub()
