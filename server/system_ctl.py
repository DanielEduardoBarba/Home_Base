"""Host service controls (WireGuard / homebased) — requires JWT; runs as root in prod."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("homebase.system")

WG_DIR = Path("/etc/wireguard")
UNIT_RE = re.compile(r"^[a-zA-Z0-9_.@+-]+$")


def list_wireguard() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if not WG_DIR.is_dir():
        return items
    for conf in sorted(WG_DIR.glob("*.conf")):
        name = conf.stem
        unit = f"wg-quick@{name}.service"
        items.append({"id": name, "unit": unit, "conf": str(conf)})
    return items


async def _systemctl(*args: str, timeout: float = 45.0) -> dict[str, Any]:
    if os.geteuid() != 0:
        # Dev: try without elevation (may fail)
        pass
    proc = await asyncio.create_subprocess_exec(
        "systemctl",
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise TimeoutError(f"systemctl {' '.join(args)} timed out")
    return {
        "ok": proc.returncode == 0,
        "code": proc.returncode,
        "stdout": (out_b or b"").decode("utf-8", errors="replace").strip(),
        "stderr": (err_b or b"").decode("utf-8", errors="replace").strip(),
    }


async def unit_active(unit: str) -> bool:
    if not UNIT_RE.match(unit):
        raise ValueError("Invalid unit name")
    r = await _systemctl("is-active", unit)
    return (r.get("stdout") or "").strip() == "active"


async def restart_unit(unit: str) -> dict[str, Any]:
    if not UNIT_RE.match(unit):
        raise ValueError("Invalid unit name")
    # restart may return non-zero briefly; check is-active after
    r = await _systemctl("restart", unit, timeout=60.0)
    active = await unit_active(unit)
    return {
        "ok": active,
        "unit": unit,
        "active": active,
        "restart": r,
    }


async def restart_homebased() -> dict[str, Any]:
    """Restart from a transient timer outside this service's cgroup.

    `systemctl restart` run inside homebased is killed with the stop
    (KillMode=control-group) and can leave the unit down. The timer survives.
    """
    from .crash_log import record_event

    record_event("warn", "homebased restart scheduled")
    timer = f"homebased-self-restart-{time.time_ns()}"
    proc = await asyncio.create_subprocess_exec(
        "systemd-run",
        "--collect",
        f"--unit={timer}",
        "--on-active=1s",
        "--timer-property=AccuracySec=100ms",
        "systemctl",
        "restart",
        "homebased.service",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=15.0)
    except asyncio.TimeoutError:
        proc.kill()
        raise TimeoutError("systemd-run timed out scheduling homebased restart")
    if proc.returncode != 0:
        err = (err_b or b"").decode("utf-8", errors="replace").strip()
        log.warning("systemd-run failed (%s): %s", proc.returncode, err)
        return await restart_unit("homebased.service")
    return {
        "ok": True,
        "unit": "homebased.service",
        "active": True,
        "scheduled": True,
        "timer": timer,
        "stdout": (out_b or b"").decode("utf-8", errors="replace").strip(),
    }


async def restart_wireguard(iface: str | None = None) -> dict[str, Any]:
    ifaces = list_wireguard()
    if not ifaces:
        raise FileNotFoundError("No WireGuard configs in /etc/wireguard")
    if iface:
        match = next((i for i in ifaces if i["id"] == iface), None)
        if not match:
            raise KeyError(f"Unknown WireGuard interface: {iface}")
        targets = [match]
    else:
        targets = ifaces
    results = []
    for t in targets:
        results.append(await restart_unit(t["unit"]))
    ok = all(r.get("ok") for r in results)
    return {"ok": ok, "results": results}
