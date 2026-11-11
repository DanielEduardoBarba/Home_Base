# Home Base — QA Round 1, part 2 (deeper runtime pass)

- **When:** 2026-11-11, ~12:45–1:20 AM America/New_York (EST). Served build **v1.17.4** on :8090 (part 1 saw v1.17.3).
- **How:** headless Playwright, desktop 1280x800 + iPhone 14; scripts `~/APP_PROJECTS/qa/e2e/homebase-r1p2.mjs` (parts A/F/B/W/L/P/Q/R) and `hb-sess.mjs`; reports `~/APP_PROJECTS/qa/reports/homebase-r1p2-*.json`.
- **Scope:** all Files/Shell actions in `~/APP_PROJECTS/qa/scratch/homebase-r1/`. Expected-fail list (Cursor chat/agents, View/Vision, WireGuard, Tunnel, presence window, systemd, email, sudo vault) not logged.

## Verdict
Core flows work, but two **Major** issues hurt everyday use: a sticky crash on reload in Files (HB-R1-08) and silent loss of unsaved edits (HB-R1-09). 10 new bugs: HB-R1-08..17 (2 Major, 6 Minor, 2 Polish) — see [homebase-r1-bugs.md](homebase-r1-bugs.md).

| Workflow | Result | Notes |
|---|---|---|
| Files: open empty / odd name `#&%+` / unicode+emoji / 40k lines | Pass | Opens fine; HTML-like file name shown as plain text (no XSS) |
| Files: 2 MB file, binary file | Pass | Clear "too large (2000000 bytes)" / "Binary file" messages |
| Files: edit + save, double-click Save | Pass | Confirm dialog; 1 PUT only |
| Files: save / list with network failure | Pass | Shows "failed — Failed to fetch" (raw wording) |
| Files: unsaved changes | **Fail** | HB-R1-09 |
| Files: reload | **Fail** | HB-R1-08 |
| Files: create / rename / upload / download / delete / empty | N/A | Not in the UI (browse + edit + save only) — Info |
| Shell: new session, 3000-line output, error command | Pass | |
| Shell: resize | Pass | 162 → 103 cols after resize |
| Shell: reload + reopen, second tab | Partial | Sessions listed after reload and re-openable; two tabs mirror one session. Env check inconclusive (picked an older session) |
| Shell: exit | Pass | Shows Offline |
| Logs: filters | **Fail** | HB-R1-10; flood HB-R1-11 |
| Logs: Pause, Copy visible, auto-stick | Pass | "copied 220"; no search box / follow toggle exists — Info |
| Apps: wizard validation (empty name, relative path) | Pass | Continue disabled |
| Apps: missing folder | Polish | HB-R1-15 |
| Apps: cancel midway | Pass | Nothing added (draft cleared) |
| Apps: add QA Test App (double-click) → remove (hold) | Pass | 1 POST; removed; seeded project unchanged |
| Apps: start/stop/restart | N/A | A blank own project has no Run actions |
| Home Access: add / edit / reload / delete | Pass | Empty-label Save blocked ("required"); confirm on delete; persists after reload |
| Home Access: double-click Save | **Fail** | HB-R1-12 |
| Settings: Appearance Night→Day, reload, revert | Pass | Persists |
| Settings: Server name change, reload, revert | Pass | Persists; restored to original |
| Notifications: Mark all read, reload | Pass | Badge clears and stays cleared |
| Session: invalid/expired token | Pass | "Session ended — sign in again" |
| Login double-click | Pass | 1 POST |
| API outage / slow API | Partial | HB-R1-13 |
| Back/forward, deep links | **Fail** | HB-R1-14 |
| Phone layout (Files, Shell, Logs, Access, Settings, Alerts) | Partial | No page overflow; HB-R1-16, HB-R1-17. Phone wizard/Access/Settings checked in part 1 only |

## Notes and leftovers
- Prior bug HB-R1-01 still reproduces on v1.17.4 (focus stays on "Add control").
- One stray click on **Start** of the seeded project's Dev server during a scripted run: no process started (nothing listening on :8080), and no config changed.
- Cleaned: QA Test App removed; all QA Home Access controls deleted (including the double-submit duplicate); 7 QA shell sessions (12:35–1:10 AM) deleted; server name and theme reverted.
- Changed as a side effect: the 2 existing security alerts (from part 1's wrong-password test) were marked read.
- Left in scratch (QA-only): `files/` fixtures (`empty.txt` now holds "qa failsave", `big-2mb.txt`, `long-40k-lines.txt`, odd/unicode/binary/HTML-named files), `qa-test-app/`, `qa-note.txt`.
