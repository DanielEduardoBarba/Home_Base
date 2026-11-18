# Home Base 1.24.37 — HB-49641-01/02 fixes (post-`49641a5`)

Developer note (not a QA pass). On `development_grok` after QA review commit `3741e7d` of tip `49641a5`. **Not deployed.** Live Home Base remains **1.24.37**; rollback remains **1.20.3**. Closes findings from `docs/qa/home-base-49641a5-review.md`.

## What changed

### HB-49641-01 — Session list contract matches Dan’s auto-drop (Medium)

Do **not** revert `5780803`. Interactive `shell` / `interactive` rows still auto-delete ~30ms after exit (same as Kill) so the SPA list updates. `run` / `expo` stay listed for dead+dismiss.

- `session_public.test.ts`: replaced stale “exited sessions stay listed until removed” (kind `shell`) with:
  - interactive shells are removed after exit
  - exited run sessions stay listed until removed
  - exited expo sessions stay listed until removed
- `ShellTab` empty-state copy: shells close on exit; dead run/Expo sessions get an X.

### HB-49641-02 — `WritableSink` TypeScript (Low)

`WritableSink.write` is now `Uint8Array`-only (writeAll only ever passes `Buffer` chunks). Fixes `cursor_sdk_host.ts` and `ipc_framing.test.ts` parameter contravariance. Framing / partial-write retry preserved; added unit coverage for partial numeric writes.

## Verification (this checkout)

| Command | Result |
|---|---|
| `cd server && npx tsc --noEmit` | **Pass** (0 errors) |
| `cd web && npx tsc --noEmit` | **Pass** (0 errors) |
| `cd server && bun test test/unit` | **Pass** — 198 pass / 110 skip / 0 fail |
| `cd web && bun test` | **Pass** — 80 pass / 0 fail (10 files) |
| `cd web && npm run build` | **Pass** — Next 15.5.27 export to `web/dist` |

### Skipped (expected, not product defects)

- Server unit: **110 skip** — `envIsolated()` suites (lockout, cookies/CSRF, session output MCP, removeRegisteredProject, etc.) when config is already imported in the combined `bun test test/unit` process. Same pattern noted in the 49641a5 QA review.
- Live Isolated Chrome / Vision / deploy / restart / real Whisper / Cursor Spending — not run (out of scope for this fix commit).

## Deploy notes

Self-deploy still belongs to Dan. This change does not restart or redeploy Home Base. Ship server + web together when Dan deploys past `49641a5`.
