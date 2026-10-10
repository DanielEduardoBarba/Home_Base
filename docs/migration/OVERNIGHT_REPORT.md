# Overnight report — Python → Bun migration (updated)

**Date:** 2026-10-10  
**VERSION:** 1.4.30  
**Cutover safe?** **Near** — Bun default for `--run`/`--deploy`. View is Bun FFI (no Python on Bun path). R-001 prod compile deploy is operator-owned.

## Completed

1. **PTY (R-004):** `Bun.Terminal` / `Bun.spawn({ terminal })` with pipe fallback
2. **View (R-002):** seat-user Bun `--view-worker` via `bun:ffi` (libX11 `XGetImage` + XTest + Xinerama); JPEG via `jpeg-js`
3. **Cursor:** `@cursor/sdk` + `homebase_*` tools + workspace persistence
4. **build.sh:** Bun default; `--python` rollback
5. **Rename:** Python → `server-py/server_py/`; Bun → `server/`

## Verified 2026-10-10

| Check | Result |
|-------|--------|
| Layout | `server/` Bun + `server-py/` Python |
| `bun run typecheck` | PASS |
| `bun test` | 12 passed |
| view-worker ping/grab | PASS (`runtime=bun`, dual monitors, JPEG `ffd8`) |
| `HOMEBASE_SELF_TEST=1` | PASS |

## Remaining gaps

| ID | Item |
|----|------|
| R-001 | Prod Bun compile deploy exercised end-to-end (manual) |
| Cursor | Full parity of every Python event type / sudo-in-shell / approvals UI |

## Startup

| Mode | Command |
|------|---------|
| Default | `./build.sh --run` |
| Python | `./build.sh --run --python` |
| Deploy Bun | `./build.sh --deploy` |
| Deploy Python | `./build.sh --deploy --python` |

## Rollback

`./build.sh --run --python` or `./build.sh --deploy --python` — `server-py/` retained (mss View).
