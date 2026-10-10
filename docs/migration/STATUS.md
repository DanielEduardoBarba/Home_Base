# Migration STATUS

- **Current phase:** Completing PTY / View / Cursor gaps
- **Last completed task:** Bun.Terminal PTY; View JSON bridge to Python X11 worker; Cursor SDK streaming + homebase_* tools
- **Current working implementation:** Bun `server/` default; Python `server-py/` via `--python`
- **Startup:** `./build.sh --run` (Bun) · `./build.sh --run --python` (rollback)
- **Commands:**
  - `cd server && bun run typecheck`
  - `cd server && bun test`
  - `HOMEBASE_SELF_TEST=1 bun run src/entry.ts`
- **Latest verification:** `build.sh` `bun_server_dir` → `server/` only; docs updated; run `bash scripts/rename-critical-path.sh` if dirs still Python `server/` + `server-ts/` (agent shell EAGAIN blocked mv/tests)
- **Next:** Confirm typecheck/tests; exercise View connect + Cursor send with API key
- **Blocked work:** Pure Bun-native X11 capture (still uses Python view-worker over JSON — see R-002)
- **VERSION:** 1.4.27
