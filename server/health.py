from __future__ import annotations

import asyncio
import socket
from typing import Any

import httpx

from .config import Project


def port_open(host: str, port: int, timeout: float = 0.35) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


async def check_port(project: Project, port_id: str) -> dict[str, Any]:
    port_def = next((p for p in project.ports if p.id == port_id), None)
    if not port_def:
        return {"id": port_id, "up": False, "error": "unknown port"}
    listening = await asyncio.to_thread(port_open, "127.0.0.1", port_def.port)
    result: dict[str, Any] = {
        "id": port_def.id,
        "label": port_def.display,
        "port": port_def.port,
        "up": listening,
        "health": None,
    }
    if listening and port_def.health:
        url = f"http://127.0.0.1:{port_def.port}{port_def.health}"
        try:
            async with httpx.AsyncClient(timeout=1.5) as client:
                r = await client.get(url)
                result["health"] = {
                    "ok": r.status_code < 500,
                    "url": url,
                    "status": r.status_code,
                }
        except Exception:
            result["health"] = {"ok": False, "url": url, "status": None}
    return result


async def project_port_status(project: Project) -> list[dict[str, Any]]:
    return [await check_port(project, p.id) for p in project.ports]
