# Home Base QA progress

Single progress log for the `development_grok` QA loop. Do not put secrets, passwords, or `.env` contents here.

## 2026-11-11 — local box stack stood up

- Branched `development_grok` from `origin/development` at `355bfa3d1ab0bb70ced9f2eb107e39802f340b73` and pushed.
- Installed Bun/Next deps with `./build.sh --setup` only. Did **not** run `--onboarding` or `--deploy`. No systemd unit, no WireGuard, no Cursor key.
- Built the Next static export (`web/dist`) and served API + UI together on **http://127.0.0.1:8090/** from a box-local data dir (`~/APP_PROJECTS/qa/run/homebase/data`).
- Launcher: `~/APP_PROJECTS/qa/run-homebase-local.sh`. QA notes: `~/APP_PROJECTS/qa/homebase-local.md`.
- Legal accepted and a local QA password bootstrapped on localhost. Credentials stay in `~/APP_PROJECTS/qa/secrets/homebase-local.env` (chmod 600), not in this log.
- Expected gaps on this box (not bugs): Cursor chat/agents, View/Vision (no X11 display), WireGuard, Cloudflare Tunnel, Tauri presence window, systemd restart, email/SMTP, sudo vault.

## 2026-11-11 (America/New_York) — HB-R1-01..07 accessible dialogs + sign-out pollers

Shared `useAccessibleDialog` / `AccessibleDialog` helper: when open, the dialog is `role=dialog` `aria-modal=true`, focus moves in, Tab is trapped, Escape closes, and focus returns to the opener. Destructive/confirm dialogs focus Cancel (`data-dialog-cancel`). Closed drawers (Notifications inbox + History) drop the dialog role and are `inert` so they leave the tab order (HB-R1-03).

Applied to Home Access Add control (HB-R1-01), Add app wizard (HB-R1-02), Notifications (HB-R1-03), Sign out and other Settings confirms (HB-R1-04), Terms/Privacy (HB-R1-05), Files save/revert/discard confirm (HB-R1-07), and the Apps shortcuts overlay.

HB-R1-06: `clearSession` stops all registered session pollers and notifies the shell once. Any API 401 clears the session. `logActivity` / `presenceHeartbeat` no-op without a token. Sign-out no longer navigates (which was posting `/api/activity` and `/api/presence/heartbeat` after the JWT was gone).

Version bump to 1.17.4.

## 2026-11-11 (America/New_York) — HB-R1-08..17 work place, dirty files, routing

- HB-R1-08: Files tab `useCallback` ran after an early `if (!project)` return, so a reload (projects empty, then loaded) changed the hook count (React error #310). The hook now always runs. `readWorkPlace` schema-validates persisted `hb-work-place:*` state and falls back to the default pane. The error boundary offers **Reset workspace view** (clears work-place keys) in addition to Reload / Reset UI prefs.
- HB-R1-09: Unsaved file edits set a navigation guard. In-app tab/area/project changes open `AccessibleDialog` titled "Leave without saving?" with Cancel focused. A `beforeunload` warning covers reload/close.
- HB-R1-10: Logs filters are derived from real ring sources (`client`, `pty`, `presence`, `boot`, plus any others present) instead of Server/Web/Cursor.
- HB-R1-11: "client log ready" is recorded once (session + server-ring dedupe); consecutive identical client lines are dropped.
- HB-R1-12: Home Access Save is disabled while submitting. The server returns an existing widget when a create with the same label, kind, and hook arrives within 8 seconds.
- HB-R1-13: A failed legal-status fetch shows a connection error with Try again (and auto-retry), not the Terms gate. After the API recovers, an already-accepted install continues in.
- HB-R1-14: Main areas and Work tabs use `pushState`/`popstate` (`/`, `/work/files`, `/view`, `/logs`, `/access`, `/agent`, `/vision`, `/settings`). Unknown paths render an in-app 404 ("This page isn't in Home Base"); SPA fallback may still be HTTP 200. Unknown `/api/*` (any method) returns JSON 404.
- HB-R1-15: Add-app wizard checks that the folder exists and is a directory on Continue (folder step), via `GET /api/fs/host-stat`.
- HB-R1-16: On small screens the Work scene gets bottom padding so the Chat button does not cover the terminal prompt or editor.
- HB-R1-17: Files path crumbs, Shell Keys / ^C / ^D, and Logs "Copy line" are at least 44px on small or coarse-pointer screens.

Version bump to 1.17.5.

Follow-up: the Next static export only pre-rendered `/`, so the App Router was sending deep links like `/work/files` back to `/` (then last-place `/work/apps`). Added an optional catch-all `app/[[...slug]]` page so client-side deep links stay on the SPA.

Follow-up: `tryServeStatic` treated any `..` substring as traversal, so it refused the Next catch-all chunk `app/[[...slug]]/*.js`. The guard now checks that the resolved path stays under `web/dist`.

Follow-up: percent-encoded catch-all paths (`%5B%5B...slug%5D%5D`) also missed the file and fell back to `index.html`. Decode the pathname before the lookup.

Follow-up: pre-render known tab paths (`/work/files`, `/view`, `/access`, …) via `generateStaticParams` and snapshot `location.pathname` before Next hydrates, so deep links are not rewritten to last-place `/work/apps`.

Follow-up: Next emits `work/files.html` (no trailing slash). The static server now tries an `.html` suffix and `index.html` before the SPA fallback so `/work/files` hydrates as Files.

Follow-up: when `selectedId` is first set after a `/work/files` deep link (projects loading late), do not replace the landed Files pane with the default Apps work-place.

## 2026-11-11 (America/New_York) — HB-R2-01..05 Files errors, shell keys, pull-to-refresh, 360px subtitle

- HB-R2-01: Listing an unreadable folder (for example `/root`) now keeps a visible `role=alert` banner: "Permission denied — Home Base can't read /root". `listDir` maps EACCES/EPERM to that message and the API returns 403. `loadDir` no longer clears the error at the start of a request, so a later refresh of the current folder cannot wipe the failed-open message. Client `request()` uses the API `detail` string as-is (no extra JSON quotes).
- HB-R2-02: The Files shortcut that opens `/` is labeled **Filesystem root (/)** so it is not mistaken for the `/root` folder.
- HB-R2-03: The phone Shell key bar (and the Keys sheet) include arrow keys (↑ ↓ ← →, ANSI CSI) for history/cursor, plus `| ~ / -`.
- HB-R2-04: The pull-to-refresh cue is `aria-hidden`, `inert`, and `tabIndex={-1}` so the invisible idle label is not in the tab order.
- HB-R2-05: The Files subtitle wraps at 360px (`min-w-0`, `break-words`) and the error sits on its own line instead of overflowing to the right.

Phone terminal 48×8 (was 48×12): left as-is. That is the intended HB-R1-16 tradeoff — `.hb-work-main` gets `padding-bottom: 4.25rem` on small screens so the Chat FAB does not cover the prompt. Restoring 12 rows would put the last lines under the pill again. QA already recorded this as an observation, not a bug, in the R1 retest.

Version bump to 1.17.6.

## 2026-11-11 (America/New_York) — HB-R2-06 desktop terminal copy

The cause was real in code, not just a headless quirk: `Terminal.tsx` had no selection or clipboard handling, so Ctrl+C always went to the PTY as SIGINT, and Ctrl+Shift+C / Cmd+C / paste did nothing. Mouse selection itself is xterm's default (no `user-select` or overlay was blocking the surface). `rightClickSelectsWord` and `macOptionClickForcesSelection` were unset; those are now on. The terminal host is marked `data-hb-no-ptr="1"` so pull-to-refresh cannot steal a drag used to select text.

- Drag to select, then **Ctrl+Shift+C** or **Cmd+C** copies.
- **Ctrl+C** copies when there is a selection, otherwise it sends the interrupt.
- **Ctrl+Shift+V** and **Cmd+V** paste via `navigator.clipboard` with an `execCommand('copy')` fallback for writes.
- A **Copy** item is on the term bar (enabled when there is a selection) and in the Keys sheet, with Paste. The phone key bar (arrows, symbols, ^C/^D) is unchanged.

Version bump to 1.17.7.


## 2026-11-13 (America/New_York) — v1.20.0 PIN lockout, MCP lockout split, Security page

Root cause of Dan's PIN pad "correct PIN keeps failing" on live 1.19.x: 18 `invalid_mcp_token` failures at 06:38 UTC went through the shared `recordFailure()` / `lockout.json`, so the human PIN/password gate was locked for 86400s. The PIN pad only shook and showed no lockout, remaining time, or password path. A stale session was a reasonable guess but was not required to produce this symptom; a valid session plus an active lockout is enough, and failed PIN verify already did not increment the counter when `assertNotLocked()` ran first.

Fixes in 1.20.0:

- Human login/PIN lockout is separate from a per-source MCP lockout.
- PIN pad and login show HTTP status and server messages, remaining attempts, lockout wait time, and a path to password sign-in. Stale/expired/invalid session tokens go to password login and do not count as a wrong PIN. `bad_pin` 401 no longer clears the session.
- Named MCP connectors with short-lived access tokens and rotating refresh tokens (`POST /mcp/token`). Refresh reuse revokes the connector. Distinct 401 codes: `mcp_token_expired`, `mcp_token_invalid`, `mcp_token_revoked`. Clients must not retry a 401 in a loop.
- Socket IP capture; `X-Forwarded-For` only from `HOMEBASE_TRUSTED_PROXIES`. User-Agent recorded. IPs mapped to WireGuard peers, connectors, and presence; classified as known Grok Bot / known VPN device / LAN / unknown-external.
- Settings → Security: lockout status, named/trusted devices (new devices flagged), filterable paginated log (time, source, IP, event, result, class badge), CSV/JSON export without secrets. Append-only hash-chained log with daily rotation. In-app alerts for lockouts, first-seen devices, and brute-force bursts.
- Same-origin check on login/PIN/password POSTs. Tokens not accepted in `/mcp` query strings. Constant-time token hash compare retained.

Version bump to 1.20.0.


## 2026-11-13 (America/New_York) — v1.20.1 HttpOnly session cookies and WebSocket tickets

Closes the two gaps left in 1.20.0 before deploy.

- Web UI session JWT moved out of `localStorage` into an `hb_session` cookie: **HttpOnly**, **SameSite=Strict**, **Secure when the request is HTTPS** (including `X-Forwarded-Proto: https` from a socket in `HOMEBASE_TRUSTED_PROXIES`). On plain HTTP (localhost, LAN, WireGuard VPN IPs) the cookie is intentionally not marked Secure, otherwise the browser would refuse to store it. HTTP is only for trusted networks; put TLS in front for anything exposed more widely.
- Double-submit CSRF (`hb_csrf` cookie + `X-CSRF-Token` header) on all cookie-authenticated state-changing `/api` requests. Bearer clients (MCP, presence app, CLI) skip CSRF and keep working with `Authorization: Bearer`. Query-string JWTs are no longer accepted for HTTP or WebSocket session auth.
- First load after upgrade clears any leftover `homebase_jwt` / `homebase_jwt_exp` / `homebase_token` in localStorage and sends the user to password/PIN login once. Existing tabs will not carry the old token forward.
- WebSockets: authenticated `POST /api/ws-ticket` mints a ≤30s single-use ticket bound to the session; the browser redeems it on connect (`?ticket=`). Tickets are hashed at rest, never logged, and rejected on reuse or expiry. Non-browser clients may still send `Authorization: Bearer` on the upgrade.

Version bump to 1.20.1. **Not deployed** from this change.


## 2026-11-13 (America/New_York) — v1.20.2 QA R7 fixes

Closes the R7 findings on 1.20.1 before deploy. See `docs/qa/homebase-1.20.2-fixes.md`.

- **HB-R7-01:** `querySecurityLog` now recomputes each entry's HMAC over canonical content plus the previous hash and walks the chain. A broken or edited line returns `integrityOk=false` with `integrityError: "tampered at line N"` (and `tamperedAt`) on the API and Security page, raises a one-shot alert, and is not listed as a normal event. Unit tests cover edited, deleted, and reordered lines.
- **HB-R7-03:** Source class is decided by credential type first. Connector tokens stay Known Grok Bot; PIN, password, and UI cookie sessions from the same IP are human (LAN or VPN device), not relabeled because MCP presence was seen there.
- **HB-R7-02:** PIN and password events from the app record `userAgent` and `path`.
- **Lows:** Logout revokes the session JWT's jti server-side (a captured cookie or Bearer no longer works). A brute-force burst alert fires even when the fifth failure is recorded as `lockout`. HTTP 423 `pin_locked` has its own PIN-pad / login message and does not look like a wrong PIN or a stale session.

Version bump to 1.20.2. **Not deployed** from this change.
