# Home Base — R2 retest on v1.17.6

- **When:** 2026-11-11, ~1:58–2:02 AM America/New_York (EST).
- **Build:** `development_grok` 1e3d85f (PR #9); `/api/health` reports 1.17.6.
- **Bundle confirmed:** `/` and `/work/files` both serve `page-926fab08e663ec76.js`.
- **How:** one script, `~/APP_PROJECTS/qa/e2e/homebase-r2-retest.mjs`, on desktop 1280x800, iPhone 14 and 360x740 (same layouts as R2). Results in `~/APP_PROJECTS/qa/reports/homebase-r2-retest.json`. It ran twice: the first phone run opened the "Keys" sheet by mistake. The arrow and symbol keys sit directly in the key bar.

| ID | Verdict | Evidence |
|---|---|---|
| HB-R2-01 | Fixed-verified (desktop, phone, 360) | Clicking `/root` shows a `role="alert"`: "Permission denied — Home Base can't read /root" (server now returns 403) |
| HB-R2-02 | Fixed-verified (all 3) | Shortcut reads "Filesystem root (/)"; the old "/ root" label is gone |
| HB-R2-03 | Fixed-verified (iPhone 14) | Key bar has ↑ ↓ ← → \| ~ / -. ↑ + Enter re-ran the last command (`QA_H1` echoed twice). ← moved the cursor (`echo QA_L` + ← + `X` printed `QA_XL`). `~` `/` `-` and `\|` typed correctly (`QA_SYM /home/box/-` piped through `cat`) |
| HB-R2-04 | Fixed-verified (desktop) | Tab order: Agent → Work → Access → Vision → Settings → back to the top. No "pull to refresh" stop |
| HB-R2-05 | Fixed-verified (360 px) | No element wider than the 360 px viewport on Files |

## Checks R2 missed
- **Phone special keys:** pass. The ^C key interrupted `sleep 30`, and the next command ran.
- **Terminal copy (desktop):** fail, filed as **HB-R2-06** (Minor, suspected; needs a manual check).

## Smoke regression (desktop): all pass
Login, dashboard (via the 404 page's "Back to Home"), Files save in scratch, Shell command, Logs, Settings, Access, Apps (view only) and sign-out all work. The only console errors were the expected 403s from the `/root` test.

## Cleanup
- 4 QA shell sessions (1:58–2:01 AM) deleted.
- Scratch `files/empty.txt` now ends with "r2rt" (QA-only).
- Nothing else created. Start not clicked.
