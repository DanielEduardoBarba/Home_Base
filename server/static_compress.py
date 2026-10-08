"""Serve Vite precompressed (.br / .gz) assets when the client accepts them."""
from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Optional

from fastapi.responses import FileResponse
from starlette.requests import Request


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


def compressed_file_response(path: Path, request: Request) -> FileResponse:
    """FileResponse preferring build-time .br / .gz siblings."""
    accept = request.headers.get("accept-encoding", "")
    media_type, _ = mimetypes.guess_type(str(path))
    chosen, encoding = _pick_compressed(path, accept)
    headers: dict[str, str] = {}
    if encoding:
        headers["Content-Encoding"] = encoding
        headers["Vary"] = "Accept-Encoding"
    return FileResponse(
        chosen,
        media_type=media_type or "application/octet-stream",
        headers=headers,
    )
