from __future__ import annotations

import asyncio
import os
import time
from typing import Any

import httpx

from .config import Project
from .ports import port_listening

# Brief cache so UI polls (and many projects) do not stampede TCP/HTTP checks.
_CACHE_TTL = 1.5
_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


def _own_listen_port() -> int:
    try:
        return int(os.environ.get("HOMEBASE_PORT", "8081") or "8081")
    except ValueError:
        return 8081


async def check_port(project: Project, port_id: str) -> dict[str, Any]:
    port_def = next((p for p in project.ports if p.id == port_id), None)
    if not port_def:
        return {"id": port_id, "up": False, "error": "unknown port"}
    listening = await asyncio.to_thread(port_listening, port_def.port)
    result: dict[str, Any] = {
        "id": port_def.id,
        "label": port_def.display,
        "port": port_def.port,
        "up": listening,
        "health": None,
    }
    if listening and port_def.health:
        url = f"http://127.0.0.1:{port_def.port}{port_def.health}"
        # Never HTTP-probe our own listen port — a nested request into the same
        # single-worker uvicorn loop can starve under load (View + UI polls).
        if port_def.port == _own_listen_port():
            result["health"] = {"ok": True, "url": url, "status": 200, "self": True}
            return result
        try:
            async with httpx.AsyncClient(timeout=1.0) as client:
                r = await client.get(url)
                result["health"] = {
                    "ok": r.status_code < 500,
                    "url": url,
                    "status": r.status_code,
                }
        except Exception:
            # Still "up" if the port accepts TCP — health is advisory only.
            result["health"] = {"ok": False, "url": url, "status": None}
    return result


async def project_port_status(project: Project) -> list[dict[str, Any]]:
    now = time.monotonic()
    hit = _cache.get(project.id)
    if hit and now - hit[0] < _CACHE_TTL:
        return hit[1]
    if not project.ports:
        out: list[dict[str, Any]] = []
    else:
        out = list(
            await asyncio.gather(
                *[check_port(project, p.id) for p in project.ports],
                return_exceptions=False,
            )
        )
    _cache[project.id] = (now, out)
    return out
