"""Serve Next static-export precompressed (.br / .gz) assets when accepted."""
from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Optional

from fastapi.responses import FileResponse
from starlette.requests import Request

# Ensure webmanifest is typed (stdlib may omit it).
mimetypes.add_type("application/manifest+json", ".webmanifest")


def _pick_compressed(path: Path, accept_encoding: str) -> tuple[Path, Optional[str]]:
    ae = accept_encoding.lower()
    if "br" in ae:
        br = Path(f"{path}.br")
        if br.is_file():
            return br, "br"
    if "gzip" in ae:
        gz = Path(f"{path}.gz")
        if gz.is_file():
            return gz, "gzip"
    return path, None


def _cache_control(path: Path) -> str:
    name = path.name.lower()
    suffix = path.suffix.lower()
    parts = path.as_posix()
    if suffix == ".html" or name == "index.html":
        return "no-cache"
    if "/_next/static/" in parts:
        return "public, max-age=31536000, immutable"
    if suffix in {".woff2", ".woff", ".svg", ".ico"}:
        return "public, max-age=86400"
    return "public, max-age=3600"


def compressed_file_response(path: Path, request: Request) -> FileResponse:
    """FileResponse preferring build-time .br / .gz siblings."""
    accept = request.headers.get("accept-encoding", "")
    media_type, _ = mimetypes.guess_type(str(path))
    chosen, encoding = _pick_compressed(path, accept)
    headers: dict[str, str] = {
        "Cache-Control": _cache_control(path),
    }
    if encoding:
        headers["Content-Encoding"] = encoding
        headers["Vary"] = "Accept-Encoding"
    return FileResponse(
        chosen,
        media_type=media_type or "application/octet-stream",
        headers=headers,
    )
