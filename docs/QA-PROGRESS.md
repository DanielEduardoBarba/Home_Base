# Home Base QA progress

Single progress log for the `development_grok` QA loop. Do not put secrets, passwords, or `.env` contents here.

## 2026-11-11 — local box stack stood up

- Branched `development_grok` from `origin/development` at `355bfa3d1ab0bb70ced9f2eb107e39802f340b73` and pushed.
- Installed Bun/Next deps with `./build.sh --setup` only. Did **not** run `--onboarding` or `--deploy`. No systemd unit, no WireGuard, no Cursor key.
- Built the Next static export (`web/dist`) and served API + UI together on **http://127.0.0.1:8090/** from a box-local data dir (`~/APP_PROJECTS/qa/run/homebase/data`).
- Launcher: `~/APP_PROJECTS/qa/run-homebase-local.sh`. QA notes: `~/APP_PROJECTS/qa/homebase-local.md`.
- Legal accepted and a local QA password bootstrapped on localhost. Credentials stay in `~/APP_PROJECTS/qa/secrets/homebase-local.env` (chmod 600), not in this log.
- Expected gaps on this box (not bugs): Cursor chat/agents, View/Vision (no X11 display), WireGuard, Cloudflare Tunnel, Tauri presence window, systemd restart, email/SMTP, sudo vault.
