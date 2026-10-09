"""Enrich PATH (and related) for PTY / action shells.

Production homebased runs as root with a minimal PATH, so user-installed
tools like pnpm (nvm / PNPM_HOME) are missing and Expo/run scripts fail.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional


def _seat_home() -> Optional[Path]:
    """Home directory of the graphical seat user (or SUDO_USER / common fallbacks)."""
    try:
        import pwd

        override = (os.environ.get("HOMEBASE_VIEW_UID") or "").strip()
        if override.isdigit():
            return Path(pwd.getpwuid(int(override)).pw_dir)

        display = (
            os.environ.get("HOMEBASE_DISPLAY")
            or os.environ.get("DISPLAY")
            or ":0"
        ).strip()
        name = display.lstrip(":").split(".")[0] or "0"
        sock = Path("/tmp/.X11-unix") / f"X{name}"
        if sock.exists():
            return Path(pwd.getpwuid(sock.stat().st_uid).pw_dir)

        xauth = (
            os.environ.get("HOMEBASE_XAUTHORITY")
            or os.environ.get("XAUTHORITY")
            or ""
        ).strip()
        if xauth and Path(xauth).is_file():
            return Path(pwd.getpwuid(Path(xauth).stat().st_uid).pw_dir)
    except Exception:
        pass

    for key in ("SUDO_USER", "HOMEBASE_SEAT_USER"):
        name = (os.environ.get(key) or "").strip()
        if not name or name == "root":
            continue
        try:
            import pwd

            return Path(pwd.getpwnam(name).pw_dir)
        except Exception:
            continue

    home_root = Path("/home")
    if home_root.is_dir():
        for child in sorted(home_root.iterdir()):
            if child.is_dir() and not child.name.startswith("."):
                return child
    return None


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


def enrich_shell_env(base: Optional[dict[str, str]] = None) -> dict[str, str]:
    """
    Copy env and prepend user tool dirs (pnpm, nvm node, etc.) to PATH.

    Safe to call for every PTY spawn (shell / run / expo / ship / action).
    """
    env = dict(base if base is not None else os.environ)
    home = _seat_home()
    if home:
        if os.geteuid() == 0 or not env.get("HOME"):
            env.setdefault("HOME", str(home))
        pnpm_home = home / ".local" / "share" / "pnpm"
        if pnpm_home.is_dir():
            env.setdefault("PNPM_HOME", str(pnpm_home))
        nvm_dir = home / ".nvm"
        if nvm_dir.is_dir():
            env.setdefault("NVM_DIR", str(nvm_dir))

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

    return env
