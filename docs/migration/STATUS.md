# Migration STATUS

- **Current phase:** Partial Bun default cutover — core REST + WS scaffolding live; View/PTY/Cursor incomplete
- **Last completed task:** T-WIRE Bun default in `build.sh`; OVERNIGHT_REPORT written
- **Current working implementation:** Bun `server-ts/` (default); Python via `--python`
- **Startup:**
  - Default: `./build.sh --run` → Bun API `:8081` + Vite `:3081`
  - Python: `./build.sh --run --python`
  - Deploy: Bun compile default; `--python` → Nuitka
- **Commands:**
  - `cd server-ts && bun run typecheck` — PASS
  - `cd server-ts && bun test` — 7 pass
  - `cd server-ts && bun run test:parity` — included in bun test
  - Python: `HOMEBASE_HOME=/tmp/hb-baseline .venv/bin/pytest tests/ -q` — 48 pass
- **Latest verification:** See VERIFICATION.md + OVERNIGHT_REPORT.md
- **Next unblocked task:** R-004 real PTY; R-002 View worker; Cursor streaming
- **Key paths:** `server-ts/src/`, `build.sh`, `docs/migration/`
- **Blocked work:** Full View (R-002), full PTY (R-004), full Cursor stream
