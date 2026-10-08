from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv


def _bundle_root() -> Path:
    """Read-only assets (web/dist, presets) — source tree or Nuitka extract dir."""
    return Path(__file__).resolve().parent.parent


def _home_root() -> Path:
    """
    Writable home for .env, projects.json, .runtime.
    - HOMEBASE_HOME if set
    - else source tree when build.sh is present (dev)
    - else /var/lib/homebase (installed binary / systemd)
    """
    env = os.environ.get("HOMEBASE_HOME", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    bundle = _bundle_root()
    if (bundle / "build.sh").is_file():
        return bundle
    return Path("/var/lib/homebase")


BUNDLE_ROOT = _bundle_root()
ROOT = _home_root()
ROOT.mkdir(parents=True, exist_ok=True)
load_dotenv(ROOT / ".env")

RUNTIME_DIR = Path(os.environ.get("HOMEBASE_RUNTIME", str(ROOT / ".runtime")))
RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
(RUNTIME_DIR / "logs").mkdir(parents=True, exist_ok=True)

CONFIG_DIR = ROOT / "config"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
PROJECTS_PATH = Path(os.environ.get("HOMEBASE_PROJECTS", str(CONFIG_DIR / "projects.json")))
# Bundled templates ship with the binary / repo; live config is under HOME.
PROJECTS_EXAMPLE = BUNDLE_ROOT / "config" / "projects.example.json"
if not PROJECTS_EXAMPLE.is_file():
    PROJECTS_EXAMPLE = CONFIG_DIR / "projects.example.json"
PRESETS_DIR = BUNDLE_ROOT / "config" / "presets"
if not PRESETS_DIR.is_dir():
    PRESETS_DIR = CONFIG_DIR / "presets"

SESSIONS_PATH = RUNTIME_DIR / "sessions.json"
AGENTS_PATH = RUNTIME_DIR / "agents.json"
LOCKOUT_PATH = RUNTIME_DIR / "lockout.json"
NOTIFICATIONS_PATH = RUNTIME_DIR / "notifications.jsonl"

_lock = threading.RLock()
_projects_cache: Optional[dict[str, "Project"]] = None
_projects_mtime: float = 0.0


@dataclass(frozen=True)
class PortDef:
    id: str
    port: int
    label: str = ""
    health: Optional[str] = None

    @property
    def display(self) -> str:
        return self.label or self.id


@dataclass(frozen=True)
class ActionDef:
    id: str
    label: str
    type: str = "script"  # script | stop | restart
    script: str = ""
    args: tuple[str, ...] = ()
    kind: str = "action"  # run | expo | ship | action | shell
    group: str = "main"
    variant: str = "default"
    hint: str = ""
    restart_action: str = ""
    env: tuple[tuple[str, str], ...] = ()

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "ActionDef":
        env_raw = raw.get("env") or {}
        return cls(
            id=str(raw["id"]),
            label=str(raw.get("label") or raw["id"]),
            type=str(raw.get("type") or "script"),
            script=str(raw.get("script") or ""),
            args=tuple(str(a) for a in (raw.get("args") or [])),
            kind=str(raw.get("kind") or "action"),
            group=str(raw.get("group") or "main"),
            variant=str(raw.get("variant") or "default"),
            hint=str(raw.get("hint") or ""),
            restart_action=str(raw.get("restartAction") or raw.get("restart_action") or ""),
            env=tuple((str(k), str(v)) for k, v in env_raw.items()),
        )


@dataclass(frozen=True)
class Project:
    id: str
    name: str
    path: Path
    ports: tuple[PortDef, ...] = ()
    actions: tuple[ActionDef, ...] = ()
    state_dir: str = ""

    @property
    def stack_log(self) -> Path:
        if self.state_dir:
            return self.path / self.state_dir / "stack.log"
        return self.path / "stack.log"

    @property
    def pid_file(self) -> Path:
        if self.state_dir:
            return self.path / self.state_dir / "devall.pids"
        return self.path / "devall.pids"

    def action(self, action_id: str) -> ActionDef:
        for a in self.actions:
            if a.id == action_id:
                return a
        raise KeyError(action_id)

    def to_public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "path": str(self.path),
            "exists": self.path.is_dir(),
            "stateDir": self.state_dir,
            "ports": [
                {
                    "id": p.id,
                    "label": p.display,
                    "port": p.port,
                    "health": p.health,
                }
                for p in self.ports
            ],
            "actions": [
                {
                    "id": a.id,
                    "label": a.label,
                    "type": a.type,
                    "script": a.script,
                    "args": list(a.args),
                    "kind": a.kind,
                    "group": a.group,
                    "variant": a.variant,
                    "hint": a.hint,
                }
                for a in self.actions
            ],
        }


@dataclass
class Settings:
    host: str = field(default_factory=lambda: os.environ.get("HOMEBASE_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(os.environ.get("HOMEBASE_PORT", "8080")))
    token: str = field(default_factory=lambda: os.environ.get("HOMEBASE_TOKEN", "").strip())
    cursor_api_key: str = field(default_factory=lambda: os.environ.get("CURSOR_API_KEY", "").strip())
    cursor_model: str = field(
        default_factory=lambda: os.environ.get("CURSOR_MODEL", "composer-2.5").strip()
    )


def get_settings() -> Settings:
    return Settings()


def _ensure_projects_file() -> None:
    if PROJECTS_PATH.is_file():
        return
    PROJECTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    if PROJECTS_EXAMPLE.is_file():
        PROJECTS_PATH.write_text(PROJECTS_EXAMPLE.read_text())
    else:
        PROJECTS_PATH.write_text(json.dumps({"projects": []}, indent=2) + "\n")


def _parse_project(raw: dict[str, Any]) -> Project:
    ports = tuple(
        PortDef(
            id=str(p["id"]),
            port=int(p["port"]),
            label=str(p.get("label") or ""),
            health=p.get("health"),
        )
        for p in (raw.get("ports") or [])
    )
    actions = tuple(ActionDef.from_dict(a) for a in (raw.get("actions") or []))
    return Project(
        id=str(raw["id"]),
        name=str(raw.get("name") or raw["id"]),
        path=Path(str(raw["path"])).expanduser().resolve(),
        ports=ports,
        actions=actions,
        state_dir=str(raw.get("stateDir") or raw.get("state_dir") or ""),
    )


def load_projects(*, force: bool = False) -> dict[str, Project]:
    global _projects_cache, _projects_mtime
    with _lock:
        _ensure_projects_file()
        mtime = PROJECTS_PATH.stat().st_mtime if PROJECTS_PATH.is_file() else 0.0
        if not force and _projects_cache is not None and mtime == _projects_mtime:
            return _projects_cache
        data = json.loads(PROJECTS_PATH.read_text() or '{"projects":[]}')
        projects: dict[str, Project] = {}
        for raw in data.get("projects") or []:
            p = _parse_project(raw)
            projects[p.id] = p
        _projects_cache = projects
        _projects_mtime = mtime
        return projects


def save_projects_raw(data: dict[str, Any]) -> None:
    with _lock:
        PROJECTS_PATH.parent.mkdir(parents=True, exist_ok=True)
        PROJECTS_PATH.write_text(json.dumps(data, indent=2) + "\n")
        load_projects(force=True)


def get_project(project_id: str) -> Project:
    projects = load_projects()
    if project_id not in projects:
        raise KeyError(project_id)
    return projects[project_id]


def list_projects() -> list[Project]:
    return list(load_projects().values())


def upsert_project(raw: dict[str, Any]) -> Project:
    project = _parse_project(raw)
    with _lock:
        _ensure_projects_file()
        data = json.loads(PROJECTS_PATH.read_text() or '{"projects":[]}')
        projects = list(data.get("projects") or [])
        replaced = False
        for i, existing in enumerate(projects):
            if existing.get("id") == project.id:
                projects[i] = raw
                replaced = True
                break
        if not replaced:
            projects.append(raw)
        data["projects"] = projects
        PROJECTS_PATH.write_text(json.dumps(data, indent=2) + "\n")
        load_projects(force=True)
    return project


def load_preset(name: str) -> dict[str, Any]:
    path = PRESETS_DIR / f"{name}.json"
    if not path.is_file():
        raise FileNotFoundError(f"Unknown preset: {name}")
    return json.loads(path.read_text())
