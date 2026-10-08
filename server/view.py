"""JWT-gated remote desktop: X11 capture + input over WebSocket.

homebased runs as root; the user X session only accepts the seat owner.
Capture/input therefore run in a forked helper that setuid()s to the owner
of /tmp/.X11-unix/X<n> before touching X11. Capture runs only while clients
are connected.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import multiprocessing as mp
import os
import struct
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
    pending: int = 0
    last_ack_seq: int = 0
    last_rtt_ms: float = 0.0
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class _XInput:
    """Minimal X11 pointer/keyboard injection via libX11 + libXtst."""

    def __init__(self) -> None:
        self._dpy: Any = None
        self._screen = 0
        self._width = 0
        self._height = 0
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
            Xtst.XTestFakeButtonEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]
            Xtst.XTestFakeKeyEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]

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
        x = max(0, min(self._width - 1, int(x)))
        y = max(0, min(self._height - 1, int(y)))
        self._Xtst.XTestFakeMotionEvent(self._dpy, self._screen, x, y, 0)
        self._X.XFlush(self._dpy)

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


def _drop_privileges(uid: int, gid: int) -> None:
    if os.geteuid() != 0 or uid == 0:
        return
    import pwd

    pw = pwd.getpwuid(uid)
    try:
        os.initgroups(pw.pw_name, gid)
    except OSError:
        try:
            os.setgroups([gid])
        except OSError:
            pass
    os.setgid(gid)
    os.setuid(uid)
    os.environ["HOME"] = pw.pw_dir
    os.environ["USER"] = pw.pw_name
    os.environ["LOGNAME"] = pw.pw_name


def _grab_jpeg(
    sct: Any,
    encode_buf: io.BytesIO,
    last_hash: bytes,
    max_width: int,
    quality: int,
) -> tuple[bytes, int, int, bool, bytes]:
    from PIL import Image

    mon = sct.monitors[0]
    sw, sh = int(mon["width"]), int(mon["height"])
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


def _x11_worker(conn: Any, display: str, xauth: str, uid: int, gid: int) -> None:
    """Child process: drop to seat user, then own all X11 I/O."""
    try:
        _drop_privileges(uid, gid)
        os.environ["DISPLAY"] = display
        os.environ["XAUTHORITY"] = xauth

        import mss

        xin = _XInput()
        sct: Any = None
        last_hash = b""
        encode_buf = io.BytesIO()

        while True:
            try:
                msg = conn.recv()
            except EOFError:
                break
            if not isinstance(msg, dict):
                continue
            cmd = msg.get("cmd")
            if cmd == "stop":
                break
            if cmd == "ping":
                ok = xin.open()
                w, h = xin.refresh_size() if ok else (0, 0)
                if not ok:
                    # Still try mss for size
                    try:
                        if sct is None:
                            sct = mss.mss()
                        mon = sct.monitors[0]
                        w, h = int(mon["width"]), int(mon["height"])
                        ok = w > 0
                    except Exception as e:
                        conn.send({"ok": False, "error": str(e) or xin.error})
                        continue
                conn.send(
                    {
                        "ok": ok,
                        "screenW": w,
                        "screenH": h,
                        "uid": os.getuid(),
                        "error": "" if ok else xin.error,
                    }
                )
                continue
            if cmd == "grab":
                try:
                    if sct is None:
                        sct = mss.mss()
                    packet, sw, sh, changed, last_hash = _grab_jpeg(
                        sct,
                        encode_buf,
                        last_hash,
                        int(msg.get("maxWidth") or DEFAULT_MAX_WIDTH),
                        int(msg.get("quality") or DEFAULT_QUALITY),
                    )
                    conn.send(
                        {
                            "ok": True,
                            "packet": packet,
                            "sw": sw,
                            "sh": sh,
                            "changed": changed,
                        }
                    )
                except Exception as e:
                    conn.send({"ok": False, "error": str(e)})
                continue
            if cmd == "pointer":
                try:
                    xin.open()
                    sw, sh = xin.size
                    if sw <= 0:
                        xin.refresh_size()
                        sw, sh = xin.size
                    nx = float(msg.get("x") or 0)
                    ny = float(msg.get("y") or 0)
                    x = int(nx * sw)
                    y = int(ny * sh)
                    action = str(msg.get("action") or "")
                    if action in ("move", "down", "up", "wheel"):
                        xin.motion(x, y)
                    if action == "down":
                        xin.button(_dom_button_to_x(int(msg.get("button") or 0)), True)
                    elif action == "up":
                        xin.button(_dom_button_to_x(int(msg.get("button") or 0)), False)
                    elif action == "wheel":
                        dy = float(msg.get("deltaY") or 0)
                        if dy:
                            xin.wheel(dy)
                    conn.send({"ok": True})
                except Exception as e:
                    conn.send({"ok": False, "error": str(e)})
                continue
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
                    conn.send({"ok": True})
                except Exception as e:
                    conn.send({"ok": False, "error": str(e)})
                continue
            conn.send({"ok": False, "error": f"unknown cmd {cmd}"})
    except Exception as e:
        try:
            conn.send({"ok": False, "error": f"worker crash: {e}"})
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


class _X11Bridge:
    """Parent-side handle to the privilege-dropped X11 worker."""

    def __init__(self) -> None:
        self._proc: Optional[mp.Process] = None
        self._conn: Any = None
        self._lock = asyncio.Lock()
        self.screen_w = 0
        self.screen_h = 0
        self.uid = -1
        self.last_error = ""

    @property
    def alive(self) -> bool:
        return bool(self._proc and self._proc.is_alive() and self._conn)

    def start(self) -> None:
        if self.alive:
            return
        self.stop()
        display, xauth = discover_x11_env()
        uid, gid = display_owner_ids(display)
        ctx = mp.get_context("fork")
        parent_conn, child_conn = ctx.Pipe(duplex=True)
        proc = ctx.Process(
            target=_x11_worker,
            args=(child_conn, display, xauth, uid, gid),
            name="homebase-view-x11",
            daemon=True,
        )
        proc.start()
        child_conn.close()
        self._proc = proc
        self._conn = parent_conn
        self.uid = uid
        log.info(
            "view X11 worker started display=%s uid=%s xauth=%s",
            display,
            uid,
            xauth,
        )

    def stop(self) -> None:
        conn = self._conn
        proc = self._proc
        self._conn = None
        self._proc = None
        if conn is not None:
            try:
                conn.send({"cmd": "stop"})
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass
        if proc is not None and proc.is_alive():
            proc.join(timeout=1.5)
            if proc.is_alive():
                proc.kill()
                proc.join(timeout=0.5)

    def _call(self, msg: dict[str, Any], timeout: float = 5.0) -> dict[str, Any]:
        if not self.alive:
            self.start()
        assert self._conn is not None
        self._conn.send(msg)
        if not self._conn.poll(timeout):
            self.last_error = "X11 worker timeout"
            self.stop()
            return {"ok": False, "error": self.last_error}
        try:
            resp = self._conn.recv()
        except EOFError:
            self.last_error = "X11 worker exited"
            self.stop()
            return {"ok": False, "error": self.last_error}
        if not isinstance(resp, dict):
            return {"ok": False, "error": "bad worker response"}
        if not resp.get("ok"):
            self.last_error = str(resp.get("error") or "X11 error")
        return resp

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
        try:
            self._bridge.start()
            resp = self._bridge._call({"cmd": "ping"}, timeout=4.0)
            ok = bool(resp.get("ok"))
            sw = int(resp.get("screenW") or 0)
            sh = int(resp.get("screenH") or 0)
            err = "" if ok else str(resp.get("error") or self._bridge.last_error)
            if sw:
                self._bridge.screen_w, self._bridge.screen_h = sw, sh
        except Exception as e:
            err = str(e)
        # Don't leave a worker running from a status probe if nobody is streaming
        if not self._clients:
            self._bridge.stop()
        return {
            "ok": ok,
            "display": display,
            "xauthority": bool(xauth and Path(xauth).is_file()),
            "screenW": sw,
            "screenH": sh,
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
        try:
            self._bridge.start()
            resp = await self._bridge.call({"cmd": "ping"})
            if resp.get("ok"):
                self._bridge.screen_w = int(resp.get("screenW") or 0)
                self._bridge.screen_h = int(resp.get("screenH") or 0)
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
            client.pending = max(0, client.pending - 1)
            client.last_ack_seq = seq
            try:
                client.last_rtt_ms = float(msg.get("rttMs") or 0)
            except (TypeError, ValueError):
                pass
            self._adapt(client)
            return
        if mtype == "config":
            client.max_width = _clamp(int(msg.get("maxWidth") or client.max_width), MIN_WIDTH, MAX_WIDTH)
            client.quality = _clamp(int(msg.get("quality") or client.quality), MIN_QUALITY, MAX_QUALITY)
            client.fps = _clamp(int(msg.get("fps") or client.fps), MIN_FPS, MAX_FPS)
            await client.ws.send_json(
                {
                    "type": "config",
                    "maxWidth": client.max_width,
                    "quality": client.quality,
                    "fps": client.fps,
                }
            )
            return
        if mtype == "pointer":
            await self._bridge.call(
                {
                    "cmd": "pointer",
                    "action": msg.get("action"),
                    "x": msg.get("x"),
                    "y": msg.get("y"),
                    "button": msg.get("button"),
                    "deltaY": msg.get("deltaY"),
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
                interval = 1.0 / max(MIN_FPS, min(MAX_FPS, fps))

                t0 = time.monotonic()
                try:
                    resp = await self._bridge.call(
                        {"cmd": "grab", "maxWidth": max_width, "quality": quality},
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
