"""Native seat-user env for PTY / action shells.

Production homebased runs as root with a minimal systemd PATH. Shell and
Run/Expo PTYs must run as the graphical seat user with a login+interactive
environment (nvm, pnpm, cargo, …) — same as a terminal on the laptop.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

log = logging.getLogger("homebase.shell_env")

_ENV_CACHE: Optional[tuple[float, int, dict[str, str]]] = None
_ENV_CACHE_TTL = 300.0  # seconds

# Propagate control-plane vars into seat PTYs when set on homebased.
_KEEP_FROM_SERVER = (
    "HOMEBASE_HOME",
    "HOMEBASE_SHARE",
    "HOMEBASE_RUNTIME",
    "HOMEBASE_HOST",
    "HOMEBASE_PORT",
    "HOMEBASE_DISPLAY",
    "HOMEBASE_XAUTHORITY",
    "HOMEBASE_VIEW_UID",
    "HOMEBASE_SEAT_USER",
    "HOMEBASE_ADVERTISE_HOST",
    "HOMEBASE_JWT_SECRET",
    "CURSOR_API_KEY",
    "CURSOR_MODEL",
    "CURSOR_SDK_BRIDGE_BIN",
    "SUDO_ASKPASS",
    "SUDO_ASKPASS_REQUIRE_PASSWORD",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
)

# Never leak root/sudo identity into seat shells.
_STRIP = {
    "SUDO_USER",
    "SUDO_UID",
    "SUDO_GID",
    "SUDO_COMMAND",
    "HOMEBASE_SELF_TEST",
    "HOMEBASE_VIEW_WORKER",
    "HOMEBASE_RUNNING_BACKUP",
}


@dataclass(frozen=True)
class SeatUser:
    uid: int
    gid: int
    name: str
    home: str
    shell: str


def resolve_seat_user() -> Optional[SeatUser]:
    """Graphical seat user (X11 socket owner) or SUDO_USER / HOMEBASE_SEAT_USER."""
    import pwd

    def _from_uid(uid: int) -> Optional[SeatUser]:
        try:
            pw = pwd.getpwuid(uid)
        except KeyError:
            return None
        if pw.pw_uid == 0 or pw.pw_name == "root":
            return None
        return SeatUser(
            uid=int(pw.pw_uid),
            gid=int(pw.pw_gid),
            name=pw.pw_name,
            home=pw.pw_dir,
            shell=pw.pw_shell or "/bin/bash",
        )

    try:
        override = (os.environ.get("HOMEBASE_VIEW_UID") or "").strip()
        if override.isdigit():
            seat = _from_uid(int(override))
            if seat:
                return seat

        display = (
            os.environ.get("HOMEBASE_DISPLAY")
            or os.environ.get("DISPLAY")
            or ":0"
        ).strip()
        name = display.lstrip(":").split(".")[0] or "0"
        sock = Path("/tmp/.X11-unix") / f"X{name}"
        if sock.exists():
            seat = _from_uid(sock.stat().st_uid)
            if seat:
                return seat

        xauth = (
            os.environ.get("HOMEBASE_XAUTHORITY")
            or os.environ.get("XAUTHORITY")
            or ""
        ).strip()
        if xauth and Path(xauth).is_file():
            seat = _from_uid(Path(xauth).stat().st_uid)
            if seat:
                return seat
    except Exception:
        pass

    for key in ("SUDO_USER", "HOMEBASE_SEAT_USER"):
        uname = (os.environ.get(key) or "").strip()
        if not uname or uname == "root":
            continue
        try:
            pw = pwd.getpwnam(uname)
            seat = _from_uid(pw.pw_uid)
            if seat:
                return seat
        except Exception:
            continue

    # Non-root process: use the current user.
    if os.geteuid() != 0:
        return _from_uid(os.getuid())

    home_root = Path("/home")
    if home_root.is_dir():
        for child in sorted(home_root.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            try:
                pw = pwd.getpwnam(child.name)
                seat = _from_uid(pw.pw_uid)
                if seat:
                    return seat
            except Exception:
                continue
    return None


def _seat_home() -> Optional[Path]:
    """Home directory of the seat user (kept for tests / callers)."""
    seat = resolve_seat_user()
    return Path(seat.home) if seat else None


def _nvm_bin_dirs(home: Path) -> list[Path]:
    nvm = home / ".nvm" / "versions" / "node"
    if not nvm.is_dir():
        return []
    versions: list[tuple[tuple[int, ...], Path]] = []
    for child in nvm.iterdir():
        if not child.is_dir():
            continue
        bin_dir = child / "bin"
        if not (bin_dir / "node").exists() and not (bin_dir / "pnpm").exists():
            continue
        nums: list[int] = []
        for part in child.name.lstrip("v").split("."):
            try:
                nums.append(int(part))
            except ValueError:
                nums.append(0)
        versions.append((tuple(nums), bin_dir))
    versions.sort(key=lambda x: x[0], reverse=True)
    return [p for _, p in versions]


def _candidate_path_dirs(home: Optional[Path]) -> list[Path]:
    dirs: list[Path] = []
    if home:
        dirs.append(home / ".local" / "share" / "pnpm")
        dirs.append(home / ".local" / "bin")
        dirs.append(home / ".bun" / "bin")
        dirs.append(home / ".cargo" / "bin")
        dirs.extend(_nvm_bin_dirs(home))
        fnm = home / ".local" / "share" / "fnm" / "aliases" / "default" / "bin"
        if fnm.is_dir():
            dirs.append(fnm)
    dirs.extend(
        [
            Path("/usr/local/bin"),
            Path("/opt/homebrew/bin"),
            Path("/snap/bin"),
        ]
    )
    return dirs


def _prepend_tool_path(env: dict[str, str], home: Optional[Path]) -> None:
    existing = env.get("PATH", os.environ.get("PATH", ""))
    parts = [p for p in existing.split(":") if p]
    seen = set(parts)
    prepend: list[str] = []
    for d in _candidate_path_dirs(home):
        try:
            if not d.is_dir():
                continue
        except OSError:
            continue
        s = str(d)
        if s in seen:
            continue
        useful = any(
            (d / name).exists()
            for name in ("pnpm", "pnpx", "node", "npm", "yarn", "corepack")
        )
        if useful or d.name in {"bin", "pnpm"}:
            prepend.append(s)
            seen.add(s)

    if prepend:
        env["PATH"] = ":".join(prepend + parts)
    elif "PATH" not in env:
        env["PATH"] = existing or "/usr/local/bin:/usr/bin:/bin"


def _setpriv_prefix(seat: SeatUser) -> Optional[list[str]]:
    if os.geteuid() != 0 or seat.uid == 0:
        return None
    setpriv = shutil.which("setpriv")
    if setpriv:
        return [
            setpriv,
            f"--reuid={seat.uid}",
            f"--regid={seat.gid}",
            "--init-groups",
            "--",
        ]
    runuser = shutil.which("runuser")
    if runuser:
        return [runuser, "-u", seat.name, "--"]
    log.warning("setpriv/runuser missing — PTY will stay root")
    return None


def seat_cmdline(cmdline: list[str], seat: Optional[SeatUser] = None) -> list[str]:
    """Wrap argv with setpriv/runuser when homebased is root and seat ≠ root."""
    if not cmdline:
        return cmdline
    seat = seat if seat is not None else resolve_seat_user()
    if not seat:
        return list(cmdline)
    prefix = _setpriv_prefix(seat)
    if not prefix:
        return list(cmdline)
    return [*prefix, *cmdline]


def _parse_env0(data: bytes) -> dict[str, str]:
    out: dict[str, str] = {}
    for chunk in data.split(b"\0"):
        if not chunk or b"=" not in chunk:
            continue
        key, _, val = chunk.partition(b"=")
        try:
            k = key.decode("utf-8", "surrogateescape")
            v = val.decode("utf-8", "surrogateescape")
        except Exception:
            continue
        if k:
            out[k] = v
    return out


def _capture_seat_login_env(seat: SeatUser) -> dict[str, str]:
    """Run a clean login+interactive shell as the seat user and dump env -0."""
    dump_shell = "/bin/bash"
    if not Path(dump_shell).is_file():
        dump_shell = seat.shell if Path(seat.shell).is_file() else "/bin/sh"

    seed = {
        "HOME": seat.home,
        "USER": seat.name,
        "LOGNAME": seat.name,
        "SHELL": seat.shell,
        "PATH": "/usr/local/bin:/usr/bin:/bin:/snap/bin",
        "TERM": "xterm-256color",
        "LANG": os.environ.get("LANG") or os.environ.get("LC_ALL") or "C.UTF-8",
    }
    # Prefer the user's login shell when it is bash/zsh so rc files match.
    shell_name = Path(seat.shell).name
    if shell_name in {"bash", "zsh"} and Path(seat.shell).is_file():
        dump_shell = seat.shell

    inner = [dump_shell, "-ilc", "env -0"]
    argv = seat_cmdline(inner, seat)
    try:
        proc = subprocess.run(
            argv,
            env=seed,
            capture_output=True,
            timeout=8,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        log.warning("seat login env capture failed: %s", e)
        return {}

    if proc.returncode != 0 and not proc.stdout:
        err = (proc.stderr or b"")[:240].decode("utf-8", "replace")
        log.warning("seat login env capture rc=%s: %s", proc.returncode, err)
        return {}

    captured = _parse_env0(proc.stdout)
    if not captured.get("HOME"):
        return {}
    return captured


def _cached_seat_login_env(seat: SeatUser) -> dict[str, str]:
    global _ENV_CACHE
    now = time.monotonic()
    if _ENV_CACHE is not None:
        ts, uid, env = _ENV_CACHE
        if uid == seat.uid and (now - ts) < _ENV_CACHE_TTL and env:
            return dict(env)
    captured = _capture_seat_login_env(seat)
    if captured:
        _ENV_CACHE = (now, seat.uid, captured)
        log.info(
            "captured seat login env user=%s path_entries=%s",
            seat.name,
            len(captured.get("PATH", "").split(":")),
        )
    return dict(captured)


def clear_seat_env_cache() -> None:
    """Test helper — drop cached login env."""
    global _ENV_CACHE
    _ENV_CACHE = None


def _inject_display(env: dict[str, str]) -> None:
    display = (
        os.environ.get("HOMEBASE_DISPLAY")
        or os.environ.get("DISPLAY")
        or env.get("DISPLAY")
        or ""
    ).strip()
    if display:
        env["DISPLAY"] = display
    xauth = (
        os.environ.get("HOMEBASE_XAUTHORITY")
        or os.environ.get("XAUTHORITY")
        or env.get("XAUTHORITY")
        or ""
    ).strip()
    if xauth and Path(xauth).is_file():
        env["XAUTHORITY"] = xauth


def enrich_shell_env(base: Optional[dict[str, str]] = None) -> dict[str, str]:
    """
    Build env for a PTY spawn: seat login+interactive profile, PATH tool
    fallbacks, control-plane keepers, then caller overrides.

    Safe to call for every PTY spawn (shell / run / expo / ship / action).
    """
    overrides = dict(base or {})
    seat = resolve_seat_user()
    home = Path(seat.home) if seat else _seat_home()

    env: dict[str, str] = {}
    if seat:
        env.update(_cached_seat_login_env(seat))
        # Force identity even if capture was partial / inherited root HOME.
        env["HOME"] = seat.home
        env["USER"] = seat.name
        env["LOGNAME"] = seat.name
        env["SHELL"] = seat.shell
    elif home:
        env.setdefault("HOME", str(home))

    if home:
        pnpm_home = home / ".local" / "share" / "pnpm"
        if pnpm_home.is_dir():
            env.setdefault("PNPM_HOME", str(pnpm_home))
        nvm_dir = home / ".nvm"
        if nvm_dir.is_dir():
            env.setdefault("NVM_DIR", str(nvm_dir))

    _prepend_tool_path(env, home)
    _inject_display(env)

    for key in _KEEP_FROM_SERVER:
        val = os.environ.get(key)
        if val is not None and val != "":
            env.setdefault(key, val)

    for key in _STRIP:
        env.pop(key, None)

    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")

    # Caller overrides win (LAN advertise host, action.env, …).
    env.update(overrides)
    # Re-assert seat identity after overrides so a stale HOME=/root cannot stick.
    if seat:
        env["HOME"] = seat.home
        env["USER"] = seat.name
        env["LOGNAME"] = seat.name
        env.setdefault("SHELL", seat.shell)
        for key in _STRIP:
            env.pop(key, None)

    return env
