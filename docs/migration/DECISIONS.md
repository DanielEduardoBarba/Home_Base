# Autonomous decisions

## D-001: TypeScript tree location

- **Choice:** `server-ts/` sibling to `server/`
- **Rationale:** Keeps Python rollback intact
- **Compatibility:** `--python` keeps FastAPI path

## D-002: HTTP/WS stack

- **Choice:** Hono on `Bun.serve`
- **Rationale:** Native Bun WebSockets, Zod-friendly

## D-003: Boundary validation

- **Choice:** Zod at every external HTTP/WS boundary

## D-004: JWT and password crypto

- **Choice:** `jose` HS256; Bun `crypto.scrypt` n=2^14,r=8,p=1,dklen=64; urlsafe base64
- **Compatibility:** Byte-compatible with `.runtime/auth.json`

## D-005: PTY

- **Choice:** `node-pty` + setpriv/runuser wrap matching `shell_env.py`

## D-006: Cursor agents

- **Choice:** `@cursor/sdk` local agents + in-process `homebase_*` tools

## D-007: Default runtime (updated)

- **Choice:** Bun is default for `--run`, `--bin`, `--service`, `--deploy`; `--python` opts into Nuitka/uvicorn
- **Rationale:** Explicit user request 2026-10-10
- **Compatibility:** Python retained for rollback; incomplete features must not be silently stubbed

## D-008: Cursor IDE hooks during migration

- **Choice:** User may clear `~/.cursor/hooks.json` to unblock IDE agents; Home Base may reinstall hooks on next start
- **Rationale:** failClosed + ask policy hung IDE Write/Shell ~10 min
