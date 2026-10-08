from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .config import Project

# Skip huge / noisy dirs in tree listings
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
MAX_TREE_ENTRIES = 800


def _safe_resolve(project: Project, rel: str) -> Path:
    root = project.path.resolve()
    target = (root / (rel or ".")).resolve()
    try:
        target.relative_to(root)
    except ValueError as e:
        raise PermissionError("Path escapes project root") from e
    return target


def list_tree(project: Project, rel: str = "", depth: int = 2) -> dict[str, Any]:
    root = _safe_resolve(project, rel)
    if not root.exists():
        raise FileNotFoundError(rel or ".")
    if not root.is_dir():
        raise NotADirectoryError(rel or ".")

    entries: list[dict[str, Any]] = []
    count = 0

    def walk(path: Path, prefix: str, remaining: int) -> None:
        nonlocal count
        if count >= MAX_TREE_ENTRIES:
            return
        try:
            children = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except PermissionError:
            return
        for child in children:
            if count >= MAX_TREE_ENTRIES:
                return
            name = child.name
            if name in SKIP_DIRS or name.startswith(".pnpm"):
                continue
            rel_path = f"{prefix}/{name}" if prefix else name
            item: dict[str, Any] = {
                "name": name,
                "path": rel_path,
                "type": "dir" if child.is_dir() else "file",
            }
            if child.is_file():
                try:
                    item["size"] = child.stat().st_size
                except OSError:
                    item["size"] = 0
            entries.append(item)
            count += 1
            if child.is_dir() and remaining > 0:
                walk(child, rel_path, remaining - 1)

    walk(root, rel.strip("/"), max(0, depth))
    return {
        "root": rel or ".",
        "entries": entries,
        "truncated": count >= MAX_TREE_ENTRIES,
    }


def list_dir(project: Project, rel: str = "") -> dict[str, Any]:
    root = _safe_resolve(project, rel)
    if not root.exists():
        raise FileNotFoundError(rel or ".")
    if not root.is_dir():
        raise NotADirectoryError(rel or ".")
    items = []
    try:
        children = sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError as e:
        raise PermissionError(str(e)) from e
    for child in children:
        if child.name in SKIP_DIRS:
            continue
        try:
            st = child.stat()
            size = st.st_size if child.is_file() else 0
        except OSError:
            size = 0
        rel_path = str(Path(rel) / child.name) if rel else child.name
        items.append(
            {
                "name": child.name,
                "path": rel_path.replace("\\", "/"),
                "type": "dir" if child.is_dir() else "file",
                "size": size,
            }
        )
    return {"path": rel or ".", "entries": items}


def read_file(project: Project, rel: str) -> dict[str, Any]:
    path = _safe_resolve(project, rel)
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
    return {
        "path": rel,
        "content": text,
        "size": size,
        "language": guess_language(rel),
    }


def write_file(project: Project, rel: str, content: str) -> dict[str, Any]:
    if len(content.encode("utf-8")) > MAX_WRITE_BYTES:
        raise ValueError("Content too large")
    path = _safe_resolve(project, rel)
    if path.exists() and path.is_dir():
        raise IsADirectoryError(rel)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return {"path": rel, "size": path.stat().st_size, "ok": True}


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
