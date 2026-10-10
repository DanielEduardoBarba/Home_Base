# Autonomous decisions

## D-001: TypeScript tree location

- **Choice (updated):** Bun lives in `server/`; Python rollback in `server-py/` (`server_py` package)
- **Rationale:** Critical-path names match Bun default; Python retained for `--python`
- **History:** Interim `server-ts/` sibling renamed via `scripts/rename-critical-path.sh`

## D-002: HTTP/WS stack

- **Choice:** Hono on `Bun.serve`
- **Rationale:** Native Bun WebSockets, Zod-friendly

## D-003: Boundary validation

- **Choice:** Zod at every external HTTP/WS boundary

## D-004: JWT and password crypto

- **Choice:** `jose` HS256; Bun `crypto.scrypt` n=2^14,r=8,p=1,dklen=64; urlsafe base64
- **Compatibility:** Byte-compatible with `.runtime/auth.json`

## D-005: PTY

- **Choice (updated):** `Bun.Terminal` / `Bun.spawn({ terminal })` + setpriv/runuser wrap matching `shell_env.py`; pipe fallback if openpty fails
- **Rejected:** `node-pty` under Bun (native panic — see R-004)

## D-009: View capture on Bun

- **Choice:** Seat-user Bun `--view-worker` with `bun:ffi` → libX11 `XGetImage` + libXtst + libXinerama; JPEG via `jpeg-js`; parent keeps JSON length-prefixed IPC
- **Rejected for Bun path:** Python mss worker (retained only for `--python`)
- **Rationale:** Root API process cannot open the seat X11 display; setpriv + same binary/entry flag mirrors deploy shape

## D-006: Cursor agents

- **Choice:** `@cursor/sdk` local agents + in-process `homebase_*` tools

## D-007: Default runtime (updated)

- **Choice:** Bun is default for `--run`, `--bin`, `--service`, `--deploy`; `--python` opts into Nuitka/uvicorn
- **Rationale:** Explicit user request 2026-10-10
- **Compatibility:** Python retained for rollback; incomplete features must not be silently stubbed

## D-008: Cursor IDE hooks during migration

- **Choice:** User may clear `~/.cursor/hooks.json` to unblock IDE agents; Home Base may reinstall hooks on next start
- **Rationale:** failClosed + ask policy hung IDE Write/Shell ~10 min
