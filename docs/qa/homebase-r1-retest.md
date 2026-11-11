# Home Base — R1 retest on v1.17.5

- **When:** 2026-11-11, desktop run ~1:36–1:39 AM, iPhone 14 run ~1:39–1:42 AM America/New_York (EST).
- **Build:** `development_grok` 674da3d (PRs #2–#8), `/api/health` version 1.17.5.
- **How:** one script, `~/APP_PROJECTS/qa/e2e/homebase-r1-retest.mjs desktop|phone` (headless Chrome, 1280x800 + iPhone 14). Results: `~/APP_PROJECTS/qa/reports/homebase-r1-retest-{desktop,phone}.json`.
- **New bundle confirmed:** the unsaved-edits prompt "Leave without saving?" and the in-app 404 ("404 · This page isn't in Home Base · Back to Home") are both served.

## Verdict: all 17 fixed-verified, no new bugs
Per-ID table: see the status section in [homebase-r1-bugs.md](homebase-r1-bugs.md). Same repro steps as the original reports.

Notes on checks that needed a manual read:
- **HB-R1-15:** the script's text match missed the new wording; the screenshot shows "path does not exist: …" on step 1, and the wizard does not advance (`*-rt-15-badpath.png`).
- **HB-R1-16:** checked from the screenshot (`phone-rt-shell.png`). The Chat pill now sits below the terminal text. Note: the terminal reports 48×8 on iPhone 14 (it was 48×12), leaving empty space above the pill. This is an observation, not a bug.

## Extra checks
| Check | Desktop | Phone |
|---|---|---|
| Cold load `/work/files` in a fresh context ×4, watching for ChunkLoadError / chunk 431 | 0/4 | 0/4, so HB-R1-18 not filed |
| Deep link `/work/files` survives reload | Pass | Pass |
| Back from `/settings` stays in app (`/`), Forward returns | Pass | Pass |
| Unknown URL → in-app 404 | Pass | Pass |
| "Reset workspace view" button | N/A | N/A |

The "Reset workspace view" button only shows on the crash screen. Corrupting `hb-work-place:*` no longer crashes the app, so I could not reach the button (it is present in `ErrorBoundary.tsx`).

`/` restores the last-used area rather than always showing the dashboard. This is by design (`App.tsx`). The dashboard is reachable from the Home button.

## Regression: all pass on both viewports
Login, sign-out (then login screen), dashboard, Files edit and save in scratch (confirm, Cancel focused), Shell command (`QA_RT_42`), Logs, Settings, Access add/edit/delete. The only console error was the deliberate network abort in the HB-R1-13 test.

## Cleanup
- The QA Access control (with a double-click check) was created, edited and deleted. 0 QA controls are left.
- 2 QA shell sessions (1:38 and 1:40 AM) deleted.
- No apps added. Did not click Start on the seeded project.
- Scratch `files/odd name #&%+.txt` now contains the retest edits (QA-only).
