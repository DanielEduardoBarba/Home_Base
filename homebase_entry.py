#!/usr/bin/env python3
"""Nuitka / CLI entrypoint for Home Base."""
from __future__ import annotations

import os
import sys
import tempfile


def self_test() -> int:
    """
    Smoke test used by /usr/bin/homebase (systemd homebased) before exec.

    Uses a throwaway HOMEBASE_HOME (and TMPDIR) so the probe never needs write
    access to /var/lib/homebased or /usr/share — works as the deploying user or root.
    """
    tmp: str | None = None
    owns_tmp = False
    try:
        preset = os.environ.get("HOMEBASE_HOME", "").strip()
        if preset and os.path.isdir(preset):
            tmp = preset
        else:
            tmp = tempfile.mkdtemp(prefix="homebased-selftest-")
            owns_tmp = True
        os.environ["HOMEBASE_HOME"] = tmp
        os.environ["HOMEBASE_RUNTIME"] = os.path.join(tmp, ".runtime")
        os.environ["TMPDIR"] = tmp
        # Reloading is unnecessary if we import after setting env — do imports here.
        from server.config import BUNDLE_ROOT, get_settings
        from server.main import app  # noqa: F401
        from server.version import read_version

        settings = get_settings()
        _ = settings.host, settings.port
        web = BUNDLE_ROOT / "web" / "dist"
        if not web.is_dir() and not (BUNDLE_ROOT / "web" / "index.html").is_file():
            print("self-test: web assets missing", file=sys.stderr)
            return 1
        print(f"self-test ok version={read_version()}")
        return 0
    except Exception as e:
        print(f"self-test failed: {e}", file=sys.stderr)
        return 1
    finally:
        if owns_tmp and tmp:
            try:
                import shutil

                shutil.rmtree(tmp, ignore_errors=True)
            except Exception:
                pass


def main() -> None:
    import uvicorn
    from server.config import get_settings
    from server.cursor_env import ensure_cursor_bridge_env
    from server.main import app
    from server.version import read_version, running_as_backup

    ensure_cursor_bridge_env()
    settings = get_settings()
    if running_as_backup():
        print(
            f"homebase: RUNNING BACKUP binary (v{read_version()}) — last deploy failed self-test",
            file=sys.stderr,
        )
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level="info",
    )


if __name__ == "__main__":
    if os.environ.get("HOMEBASE_SELF_TEST", "").strip() in ("1", "true", "yes") or "--self-test" in sys.argv:
        raise SystemExit(self_test())
    os.environ.setdefault("HOMEBASE_HOST", os.environ.get("HOMEBASE_HOST", "0.0.0.0"))
    main()
