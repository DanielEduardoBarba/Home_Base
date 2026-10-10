# Overnight report — Python → Bun migration (updated)

**Date:** 2026-10-10  
**VERSION:** 1.4.25  
**Cutover safe?** **Partial** — Bun is default for `--run`/`--deploy`. View works via Python X11 worker JSON bridge. Pure zero-Python View still R-002.

## Completed this continuation

1. **PTY (R-004):** `Bun.Terminal` / `Bun.spawn({ terminal })` with pipe fallback (replaces crashed `node-pty`)
2. **View:** Bun `ViewHub` + JSON IPC to seat-user Python view-worker (`HOMEBASE_VIEW_JSON=1` in `server-py/server_py/view.py`)
3. **Cursor:** `@cursor/sdk` Agent create/resume + stream mapping + `homebase_*` custom tools + workspace persistence
4. **build.sh:** Bun default; `--python` rollback (from earlier)

## Verified earlier (before host EAGAIN)

| Check | Result |
|-------|--------|
| Python pytest | 48 passed |
| `bun run typecheck` | PASS (pre-ViewHub expansion) |
| `bun test` | 7 passed |
| Self-test / boot | PASS |

**Host note:** Late session blocked by `spawn EAGAIN` — re-run locally:

```bash
cd server && bun run typecheck && bun test
HOMEBASE_SELF_TEST=1 bun run src/entry.ts
./build.sh --run
```

## Remaining gaps

| ID | Item |
|----|------|
| R-002 | Zero-Python View (still needs mss/XTest worker process) |
| R-001 | Prod Bun compile deploy exercised end-to-end |
| Cursor | Full parity of every Python event type / sudo-in-shell / approvals UI |

## Startup

| Mode | Command |
|------|---------|
| Default | `./build.sh --run` |
| Python | `./build.sh --run --python` |
| Deploy Bun | `./build.sh --deploy` |
| Deploy Python | `./build.sh --deploy --python` |

## Rollback

`./build.sh --run --python` or `./build.sh --deploy --python` — `server-py/` retained.
