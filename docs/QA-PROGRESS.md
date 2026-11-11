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
