"""Port listen checks and kill-by-port (works for processes started outside Home Base)."""

from __future__ import annotations

import os
import signal
import socket
from pathlib import Path
from typing import Iterable

# systemd unit for this control plane — never SIGKILL via project Stop / kill_ports.
HOMEBASED_UNIT = "homebased.service"


def port_open(host: str, port: int, timeout: float = 0.35) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def port_listening(port: int) -> bool:
    """True if something accepts TCP on this port (IPv4 or IPv6 loopback)."""
    if port_open("127.0.0.1", port):
        return True
    try:
        if port_open("::1", port):
            return True
    except OSError:
        pass
    return False


def _inodes_for_port(port: int) -> set[int]:
    """Inodes of sockets listening on `port` (any interface)."""
    want = f"{port:04X}"
    found: set[int] = set()
    for path in (Path("/proc/net/tcp"), Path("/proc/net/tcp6")):
        if not path.is_file():
            continue
        try:
            lines = path.read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 10 or parts[3] != "0A":
                continue
            local = parts[1]
            if ":" not in local:
                continue
            _, phex = local.rsplit(":", 1)
            if phex.upper() != want:
                continue
            try:
                inode = int(parts[9])
            except ValueError:
                continue
            if inode > 0:
                found.add(inode)
    return found


def _pids_for_inodes(inodes: set[int]) -> set[int]:
    if not inodes:
        return set()
    pids: set[int] = set()
    proc = Path("/proc")
    try:
        entries = list(proc.iterdir())
    except OSError:
        return pids
    for entry in entries:
        name = entry.name
        if not name.isdigit():
            continue
        fd_dir = entry / "fd"
        try:
            for fd in fd_dir.iterdir():
                try:
                    target = os.readlink(fd)
                except OSError:
                    continue
                if not target.startswith("socket:["):
                    continue
                try:
                    inode = int(target[8:-1])
                except ValueError:
                    continue
                if inode in inodes:
                    pids.add(int(name))
                    break
        except OSError:
            continue
    return pids


def pids_on_port(port: int) -> set[int]:
    """PIDs with a LISTEN socket on `port`."""
    return _pids_for_inodes(_inodes_for_port(port))


def control_plane_ports() -> set[int]:
    """Listen ports owned by this Home Base process (use systemctl, not kill)."""
    out: set[int] = set()
    raw = (os.environ.get("HOMEBASE_PORT") or "").strip()
    if raw.isdigit():
        out.add(int(raw))
    return out


def _self_ancestry() -> set[int]:
    """This process and its parents (Nuitka onefile parent must not be SIGKILL'd)."""
    seen: set[int] = set()
    pid = os.getpid()
    for _ in range(64):
        if pid <= 1 or pid in seen:
            break
        seen.add(pid)
        try:
            status = Path(f"/proc/{pid}/status").read_text()
        except OSError:
            break
        ppid = 0
        for line in status.splitlines():
            if line.startswith("PPid:"):
                try:
                    ppid = int(line.split()[1])
                except (IndexError, ValueError):
                    ppid = 0
                break
        pid = ppid
    return seen


def pid_in_homebased_unit(pid: int) -> bool:
    try:
        return HOMEBASED_UNIT in Path(f"/proc/{pid}/cgroup").read_text()
    except OSError:
        return False


def is_protected_pid(pid: int) -> bool:
    """True if we must not kill this pid (control plane / self tree)."""
    if pid <= 1:
        return True
    if pid in _self_ancestry():
        return True
    if pid_in_homebased_unit(pid):
        return True
    return False


def kill_pids(pids: Iterable[int]) -> list[int]:
    """SIGTERM then SIGKILL process groups / pids. Returns ones we signaled."""
    stopped: list[int] = []
    for pid in sorted(set(pids)):
        if is_protected_pid(pid):
            continue
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                os.kill(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                continue
        stopped.append(pid)
    # brief grace then force
    for pid in list(stopped):
        try:
            os.kill(pid, 0)
        except OSError:
            continue
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
    return stopped


def kill_ports(ports: Iterable[int]) -> list[int]:
    """Kill listeners on the given ports — never the Home Base control plane."""
    pids: set[int] = set()
    protected = control_plane_ports()
    for port in ports:
        port = int(port)
        if port in protected:
            continue
        pids |= pids_on_port(port)
    return kill_pids(pids)
