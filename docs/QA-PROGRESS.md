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
