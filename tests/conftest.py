from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SP = ROOT / "server-py"
if SP.is_dir() and str(SP) not in sys.path:
    sys.path.insert(0, str(SP))
elif str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
try:
    import server_py  # noqa: F401
except ImportError:
    import server as server_py  # type: ignore[no-redef]

    sys.modules["server_py"] = server_py


@pytest.fixture()
def auth_runtime(tmp_path, monkeypatch):
    """Isolate auth.json / jwt_secret / lockout under a temp .runtime."""
    import server_py.auth as auth
    import server_py.logging_util as logging_util
    import server_py.notifications as notifications

    runtime = tmp_path / ".runtime"
    runtime.mkdir()
    logs = runtime / "logs"
    logs.mkdir()
    monkeypatch.setattr(auth, "RUNTIME_DIR", runtime)
    monkeypatch.setattr(auth, "AUTH_PATH", runtime / "auth.json")
    monkeypatch.setattr(auth, "JWT_SECRET_PATH", runtime / "jwt_secret")
    monkeypatch.setattr(auth, "LOCKOUT_PATH", runtime / "lockout.json")
    monkeypatch.setattr(logging_util, "LOG_DIR", logs)
    monkeypatch.setattr(notifications, "RUNTIME_DIR", runtime)
    monkeypatch.setattr(notifications, "NOTIFICATIONS_PATH", runtime / "notifications.jsonl")
    monkeypatch.delenv("HOMEBASE_JWT_SECRET", raising=False)
    yield runtime
