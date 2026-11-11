# Home Base — QA Round 1 (UX + runtime)

- **When:** 2026-11-11, ~12:34–12:42 AM America/New_York (EST)
- **Build:** http://127.0.0.1:8090/ · v1.17.3 · branch `development_grok` (from development 355bfa3, docs ca27e4c)
- **Tooling:** headless Playwright (Chrome) from `~/APP_PROJECTS/qa/e2e/homebase-r1-*.mjs`; desktop 1280x800 + iPhone 14; console + network watched.
- **Account:** the box's local Home Base login (secret in the QA secrets file, not in this repo). No new accounts created.

## Verdict
Usable and stable. **No crashes, no page errors, no 5xx** on either viewport. 7 issues found — all Minor/Polish (keyboard/a11y + console noise). No Blockers/Majors.

| Area | Desktop | Phone | Notes |
|---|---|---|---|
| Legal acceptance | Pass | Pass | v1 already accepted on this box; Terms/Privacy viewed via Settings → About & legal (HB-R1-05) |
| Login (wrong pw / right pw) | Pass | Pass | Clear error + security alert; only expected 401 |
| Logout + relogin | Pass | Pass | "Sign out?" confirm (HB-R1-04); post-logout 401 noise (HB-R1-06) |
| Session persists on reload | Pass | Pass | |
| Dashboard | Pass | Pass | No horizontal overflow on phone |
| Apps (seeded project) | Pass | Pass | Add-app wizard opens/closes (HB-R1-02); Ship/Remove are hold-to-confirm |
| Files | Pass | Pass | Edited + saved a file in the QA scratch folder only (HB-R1-07) |
| Shell | Pass | Pass | Session in scratch folder; `exit` shows session ended/Offline |
| Logs | Pass | Pass | Loads, no errors |
| Settings | Pass | Pass | All sections render; Agent degrades gracefully |
| Home Access | Pass | Pass | Add control dialog (HB-R1-01) — cancelled, nothing saved |
| Notifications drawer | Pass | Pass | Hold-to-clear works; hidden drawer focusable (HB-R1-03) |

Bugs: see [homebase-r1-bugs.md](homebase-r1-bugs.md). Screenshots: `docs/qa/screenshots/homebase-r1/`.

## Not logged (expected on this box, per brief)
Cursor chat/agents, View/Vision, WireGuard, Cloudflare Tunnel, presence desktop window, systemd restarts, email, sudo vault.

## Safety
Files/Shell actions confined to `~/APP_PROJECTS/qa/scratch/homebase-r1/` (one file, `qa-note.txt`, left as a QA artifact). No system settings changed, no app code edited, server not restarted, `QA-PROGRESS.md` untouched.

## Info (not a bug)
Seeded project shows "API :8080" on Apps/Shell while this stack serves on :8090 — config default, may confuse first-time users.
