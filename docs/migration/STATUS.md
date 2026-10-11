# Migration STATUS

- **Current phase:** Complete — Bun is the sole server; Next.js is the sole SPA
- **Working implementation:** Bun `server/` + Next static export `web/` → `web/dist`
- **Startup:** `./build.sh --run` (Bun API + Next)
- **Commands:**
  - `cd server && bun run typecheck`
  - `cd server && bun test`
  - `HOMEBASE_SELF_TEST=1 bun run src/entry.ts`
  - `cd web && npm run build`
- **Latest verification:** Bun-only cutover — `server-py/`, Nuitka entry, and pytest suite deleted from the repo
- **VERSION:** see repo `VERSION`
- **Note:** DECISIONS / OVERNIGHT_REPORT retain cutover history only
