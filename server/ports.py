"""Port listen checks and kill-by-port (works for processes started outside Home Base)."""

from __future__ import annotations

import os
import signal
import socket
from pathlib import Path
from typing import Iterable


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


def kill_pids(pids: Iterable[int]) -> list[int]:
    """SIGTERM then SIGKILL process groups / pids. Returns ones we signaled."""
    stopped: list[int] = []
    for pid in sorted(set(pids)):
        if pid <= 1 or pid == os.getpid():
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
    """Kill every process listening on any of the given ports."""
    pids: set[int] = set()
    for port in ports:
        pids |= pids_on_port(int(port))
    return kill_pids(pids)
