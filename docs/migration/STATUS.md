# Migration STATUS

- **Current phase:** Cutover hardening (R-001 deploy manual)
- **Last completed task:** R-002 Bun-native View (`bun:ffi` X11 + XTest worker; no Python on Bun path)
- **Current working implementation:** Bun `server/` default; Python `server-py/` (`server_py`) via `--python`
- **Startup:** `./build.sh --run` (Bun) · `./build.sh --run --python` (rollback)
- **Commands:**
  - `cd server && bun run typecheck`
  - `cd server && bun test`
  - `HOMEBASE_SELF_TEST=1 bun run src/entry.ts`
- **Latest verification:** typecheck PASS; `bun test` 12 pass; view-worker ping+grab on `:0` (JPEG HBVF); self-test ok
- **Next:** User exercises R-001 prod Bun deploy manually
- **Blocked work:** none for View; R-001 left to operator
- **VERSION:** 1.4.31 (View JPEG was RGB→jpeg-js; fixed to RGBA)
