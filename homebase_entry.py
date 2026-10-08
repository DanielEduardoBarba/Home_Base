#!/usr/bin/env python3
"""Nuitka / CLI entrypoint for Home Base."""
from __future__ import annotations

import os


def main() -> None:
    import uvicorn
    from server.config import get_settings
    from server.main import app

    settings = get_settings()
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level="info",
    )


if __name__ == "__main__":
    os.environ.setdefault("HOMEBASE_HOST", os.environ.get("HOMEBASE_HOST", "0.0.0.0"))
    main()
