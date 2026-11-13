# Home Base — R7b QA retest, version 1.20.2

- **When:** 2026-11-13, 8:05–8:12 AM America/New_York (EST).
- **Build tested:** `development_grok` tip **61cbb67** (`61cbb67d7be92bc211a27fe1d676b52bf72db559`, message `fix(auth): verify security-log chain, classify humans vs bots, revoke logout (v1.20.2)`). `VERSION` **1.20.2**. After `git fetch origin development_grok`, local and `origin/development_grok` were already at this SHA — **the tip did not move** from the requested `61cbb67`.
- **Commits since R7 docs `fe82bdd`:** only `61cbb67`. Developer notes read first: `docs/qa/homebase-1.20.2-fixes.md`. This retest covers the bugs filed in `docs/qa/homebase-r7-1.20.1.md` (HB-R7-01, HB-R7-02, HB-R7-03, and the three lows), plus a short smoke regression.
- **How:** Detached worktree at `/tmp/qa-hb-r7b/src`. Throwaway Bun on **127.0.0.1:18090** with throwaway data, `.runtime`, and `HOMEBASE_MCP_WORKSPACES_ROOT` under `/tmp/qa-hb-r7b`. `HOMEBASE_TRUSTED_PROXIES=127.0.0.1`. 1.20.2 web UI built **into the worktree `web/dist` only** (live `web/dist` still dated 2026-11-11 02:08:16 -0500 was not overwritten). Headless Playwright from `~/APP_PROJECTS/qa/e2e/hb-r7b-gui*.mjs`; screenshots in `~/APP_PROJECTS/qa/screenshots/hb-r7b/`. Live **:8090** (pid **1198759**) was not restarted, rebuilt, or reconfigured.
- **Not used:** Clock Trakr, Ekklesias, :4210, emulators, App Store Connect, WireGuard, a Cursor API key (`cursorConfigured=false`), `gh auth login`, `--deploy`, force-push, a `main` merge, or app-code edits. Secrets were not written into the repo or this doc.

## Verdict

**Pass, with one leftover Low.** HB-R7-01, HB-R7-02, HB-R7-03, logout revocation, and the burst alert all held on the throwaway 1.20.2 instance. Smoke (PIN after 25 bad connector tokens, WebSocket ticket, bot Bearer, unit tests, `tsc`) is green.

The remaining gap is the 423 PIN-pad copy: the API returns `423` `pin_locked` (“App PIN required”), and `parseAuthError` has a distinct `pin_required` headline, but the PIN pad that appears after an in-app 423 does not show that headline or an `HTTP 423` status line (HB-R7b-01).

**Ready for Dan’s self-deploy of 1.20.2**, with that Low in mind. Ship **server and web together**. Do not deploy 1.20.0 or 1.20.1 alone. This 1.20.2 build is the one that should go out. Self-deploy still belongs to Dan.

## Results

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | HB-R7-01: an edited, a deleted, and a reordered log line are each detected as `tampered at line N` in the API and on the Security page, with a one-time alert; a clean log stays OK | **Pass** | A clean log returned `integrityOk=true` and no `integrityError`. After editing a `message` field, deleting a middle line, and swapping two lines (restoring the file between cases), `GET /api/security/events` returned `integrityOk=false`, `integrityError` of `tampered at line 1` or `tampered at line 2`, and `tamperedAt: { day: "2026-11-13", line: N }`. The edited `TAMPER-R7B-EDIT` text was **not** returned as a normal event. Three “Security log tampered” notifications were raised (one per distinct break). Re-querying the same break did not add a fourth alert. The Security page showed a red **“Security log integrity failure: tampered at line 2.”** banner in the Security log section (`hb-r7b-02b-security-integrity.png`). Isolated `security_log.test.ts`: **9/9**, including the three new detection tests. |
| 2 | HB-R7-03: a PIN, password, or cookie sign-in from an IP that also has MCP presence is labeled as a person on a LAN/VPN device; a connector token is labeled as a bot | **Pass** | After a successful connector `/mcp` initialize from `127.0.0.1`, subsequent `login_success` and `pin_success` (cookie + CSRF session) from that same address stayed class **`lan`**. Zero UI events were labeled `known_grok_bot`. MCP `invalid_mcp_token` events (and the “R7b Connector” device) were class **`known_grok_bot`**. The Security page listed LAN devices as **LAN** and **R7b Connector** as **Known Grok Bot** (`hb-r7b-02-security-tamper.png`, `hb-r7b-02b-security-integrity.png`). Unit test “human UI events stay human when the same IP has MCP presence (HB-R7-03)” passed. |
| 3 | HB-R7-02: user agent and path are recorded on login and PIN unlock | **Pass** | `login_success` events had `userAgent: "R7bQA-Login/1.0"` and `path: "/api/login"`. `pin_success` events had `userAgent: "R7bQA-PinUnlock/1.0"` and `path: "/api/app-pin/unlock"`. Playwright browser events also recorded the Chrome UA on UI rows in the Security log. Unit test “PIN and password failures record user agent and path (HB-R7-02)” passed. |
| 4 | Low: after logout, a captured cookie gets `401 revoked_session` | **Pass** | `POST /api/logout` returned 200 and expired cookies. Presenting the pre-logout `hb_session` value to `/api/app-pin/status` returned **`401` `revoked_session`** (“Session ended — sign in again”). `GET /api/auth/session` with that cookie reported `authenticated: false`. A request with no cookies was unauthenticated. Unit test “logout revokes the server-side session token, not only the cookie” passed. |
| 5 | Low: the burst alert fires when the 5th failure is the lockout | **Pass** | Five bad PINs from `X-Forwarded-For: 203.0.113.91` produced four `pin_failure` / `failure` events and a fifth `pin_failure` / **`lockout`**. Notifications included **Brute-force burst** and **Auth lockout**. (The 5th HTTP response was still `401` `bad_pin`, because `unlockAppPin` calls `assertNotLocked()` before `recordFailure`; the 5th attempt is the one that records the lockout, and a later attempt is `429`. That HTTP timing is unchanged and was not the subject of this retest.) Unit test “burst alert fires when the fifth human failure is itself the lockout” passed. |
| 6 | Low: a 423 shows its own PIN-required message | **Fail** in the PIN pad (API/parser **Pass**) — **HB-R7b-01** | A cookie session with the App PIN locked received **`423` `pin_locked`**, message **“App PIN required”**, on `GET /api/security/events`. `parseAuthError` maps that to headline “App PIN required. Unlock with your PIN to continue.” and `HTTP 423 · …`. After locking the PIN and clicking the in-app Security **Refresh** button (the API client path that dispatches `hb-pin-lock`), the PIN pad appeared (`hb-r7b-03-pin-423.png`) but showed only “Enter PIN” / “Server keeps running — unlock to use this client” — **no** PIN-required headline and **no** `HTTP 423` status line. `PinLock` listens for a bare `hb-pin-lock` event and does not apply the new `pin_required` copy. |
| 7 | Smoke: correct PIN after 25 bad connector tokens; WebSocket ticket; bot Bearer; unit tests alone; `tsc` | **Pass** | 25 bad MCP bearers: **5×401** then **20×429**. Human lockout stayed unlocked (`failCount` 0). Correct PIN unlocked (`200`, `locked: false`). `POST /api/ws-ticket` returned `expiresIn=30`; a live `?ticket=` connect opened (`readyState` open). A valid connector Bearer on `/mcp` returned 200 (an immediate retry on the same IP after the 25 bad tokens was `429` until the throwaway `mcp_lockout.json` was cleared — expected per-source MCP lockout, not a regression; a reminted Bearer then returned 200). Isolated `bun test`: `security_log.test.ts` **9/9**, `session_ws.test.ts` **10/10**, `lockout.test.ts` **3/3**, `mcp_tokens.test.ts` **4/4**. `bunx tsc --noEmit` in `server/` and `web/`: **0** errors. Throwaway health: `version: "1.20.2"`, `cursorConfigured: false`. |

## New bugs

### HB-R7b-01 — 423 PIN-required copy is not shown on the PIN pad — **Low**

- **Steps:** Sign in, unlock the App PIN, then lock it (`POST /api/app-pin/lock`). In the UI, trigger a gated request that goes through the web API client (for example Settings → Security → Refresh).
- **Expected:** The PIN pad shows “App PIN required. Unlock with your PIN to continue.” and an `HTTP 423 · App PIN required` status line. It does not look like a wrong PIN and does not send the user to password login.
- **Actual:** The request is `423` `pin_locked` (“App PIN required”). The pad appears, which is correct, but the new headline and status line are missing (`hb-r7b-03-pin-423.png`). `api.ts` dispatches a parameterless `hb-pin-lock` event; `PinLock` covers the UI and does not call `parseAuthError` on that path. The copy exists only in `parseAuthError`.

## Closed from R7

- **HB-R7-01** (High) — fixed; retested Pass.
- **HB-R7-02** (Medium) — fixed; retested Pass.
- **HB-R7-03** (Medium) — fixed; retested Pass.
- Logout JWT revocation (Low) — fixed; retested Pass.
- Burst alert on the lockout event (Low) — fixed; retested Pass.
- Distinct 423 copy (Low) — parser and API are in place; UI display still missing (HB-R7b-01).

## Not tested, and why

- **True live Cursor invalid-model run / MCP-finished webhook** — this box still has no Cursor API key; out of scope for this retest.
- **HTTPS via a real TLS terminator** — not in scope for R7b.
- **The live :8090 GUI** — on purpose. That process was left running (pid 1198759). Live health may read `VERSION` from disk after a checkout; that is not proof the long-lived process has 1.20.2 logic in memory.

## Screenshots (throwaway :18090, not in this commit)

Under `~/APP_PROJECTS/qa/screenshots/hb-r7b/`: `hb-r7b-01-home.png`, `hb-r7b-02-security-tamper.png` (devices: LAN vs Known Grok Bot), `hb-r7b-02b-security-integrity.png` (integrity banner: “tampered at line 2”), `hb-r7b-03-pin-423.png` (PIN pad after a 423, without the new copy).

## Cleanup

Throwaway process on :18090 will be stopped after this doc is committed. `/tmp/qa-hb-r7b` will be removed. Live :8090 (pid 1198759) and `~/APP_PROJECTS/qa/run/homebase/data` will not be modified. Playwright scripts remain under `~/APP_PROJECTS/qa/e2e/` (scratch, not this repo).
