from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import Project

# Skip huge / noisy dirs in directory listings
SKIP_DIRS = {
    "node_modules",
    ".git",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    ".expo",
    "__pycache__",
    ".pnpm-store",
    "coverage",
    ".turbo",
    ".cache",
}

MAX_READ_BYTES = 1_500_000
MAX_WRITE_BYTES = 1_500_000


def _is_absolute_api_path(path: str) -> bool:
    """True when the client sent a host-absolute path (Linux root browse)."""
    return (path or "").startswith("/")


def _resolve(project: Project, path: str) -> Path:
    """
    Resolve a files-API path.

    - Absolute paths (`/…`) may point anywhere on the host filesystem.
    - Empty / `.` / relative paths stay scoped under the project root
      (Cursor cwd picker and legacy clients).
    """
    raw = (path or "").strip()
    if "\x00" in raw:
        raise PermissionError("Invalid path")

    if _is_absolute_api_path(raw):
        return Path(raw).resolve()

    root = project.path.resolve()
    if not raw or raw == ".":
        return root
    target = (root / raw).resolve()
    try:
        target.relative_to(root)
    except ValueError as e:
        raise PermissionError("Path escapes project root") from e
    return target


def _entry_path(request_path: str, parent: Path, child: Path) -> str:
    if _is_absolute_api_path(request_path):
        return str(child)
    rel = request_path.strip("/")
    name = child.name
    return f"{rel}/{name}" if rel else name


def list_dir(
    project: Project, rel: str = "", *, include_ignored: bool = False
) -> dict[str, Any]:
    target = _resolve(project, rel)
    if not target.exists():
        raise FileNotFoundError(rel or ".")
    if not target.is_dir():
        raise NotADirectoryError(rel or ".")

    abs_mode = _is_absolute_api_path(rel)
    items = []
    try:
        children = sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError as e:
        raise PermissionError(str(e)) from e
    for child in children:
        if not include_ignored and child.name in SKIP_DIRS:
            continue
        try:
            st = child.stat()
            size = st.st_size if child.is_file() else 0
        except OSError:
            size = 0
        item_path = _entry_path(rel, target, child).replace("\\", "/")
        items.append(
            {
                "name": child.name,
                "path": item_path,
                "type": "dir" if child.is_dir() else "file",
                "size": size,
                "ignored": child.name in SKIP_DIRS,
            }
        )
    display = str(target) if abs_mode else (rel or ".")
    return {"path": display, "entries": items, "includeIgnored": include_ignored}


def read_file(project: Project, rel: str) -> dict[str, Any]:
    path = _resolve(project, rel)
    if not path.is_file():
        raise FileNotFoundError(rel)
    size = path.stat().st_size
    if size > MAX_READ_BYTES:
        raise ValueError(f"File too large to edit in browser ({size} bytes)")
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("Binary file — cannot open in text editor")
    out_path = str(path) if _is_absolute_api_path(rel) else rel
    return {
        "path": out_path,
        "content": text,
        "size": size,
        "language": guess_language(out_path),
    }


def write_file(project: Project, rel: str, content: str) -> dict[str, Any]:
    if len(content.encode("utf-8")) > MAX_WRITE_BYTES:
        raise ValueError("Content too large")
    path = _resolve(project, rel)
    if path.exists() and path.is_dir():
        raise IsADirectoryError(rel)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    out_path = str(path) if _is_absolute_api_path(rel) else rel
    return {"path": out_path, "size": path.stat().st_size, "ok": True}


def guess_language(path: str) -> str:
    ext = Path(path).suffix.lower()
    return {
        ".py": "python",
        ".ts": "typescript",
        ".tsx": "tsx",
        ".js": "javascript",
        ".jsx": "jsx",
        ".json": "json",
        ".md": "markdown",
        ".css": "css",
        ".html": "html",
        ".sh": "shell",
        ".yml": "yaml",
        ".yaml": "yaml",
        ".toml": "toml",
        ".rs": "rust",
        ".go": "go",
        ".sql": "sql",
    }.get(ext, "plaintext")
