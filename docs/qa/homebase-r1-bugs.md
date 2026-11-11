# Home Base — Round 1 bugs (2026-11-11, America/New_York)

Severity: Blocker > Major > Minor > Polish. All repro on desktop 1280x800 and iPhone 14 unless noted.

## Status — retest on v1.17.5 (674da3d), 2026-11-11 ~1:36–1:42 AM America/New_York

| ID | Severity | Status | Evidence |
|---|---|---|---|
| HB-R1-01 | Minor | **Fixed-verified** | Focus moves into dialog, aria-modal, Escape closes |
| HB-R1-02 | Polish | **Fixed-verified** | Escape closes wizard |
| HB-R1-03 | Minor | **Fixed-verified** | 30 Tabs: no off-screen focus |
| HB-R1-04 | Polish | **Fixed-verified** | role=dialog, Cancel focused, Escape closes |
| HB-R1-05 | Polish | **Fixed-verified** | Escape closes Terms |
| HB-R1-06 | Minor | **Fixed-verified** | 0 calls / 0×401 in 12 s after sign-out |
| HB-R1-07 | Polish | **Fixed-verified** | Cancel focused |
| HB-R1-08 | Major | **Fixed-verified** | 0/4 reloads crashed (Files ×3, Shell) on both viewports |
| HB-R1-09 | Major | **Fixed-verified** | 'Leave without saving?' (Cancel focused), edit kept, beforeunload on reload |
| HB-R1-10 | Minor | **Fixed-verified** | Filters now Boot/Client/Presence/PTY and match lines |
| HB-R1-11 | Minor | **Fixed-verified** | 1 'client log ready' line in buffer |
| HB-R1-12 | Minor | **Fixed-verified** | Double-click Save → 1 POST, 1 control |
| HB-R1-13 | Minor | **Fixed-verified** | Shows 'Can't reach Home Base' (not legal gate) and recovers |
| HB-R1-14 | Minor | **Fixed-verified** | /work/files survives reload; Back stays in app; unknown URL → in-app 404 |
| HB-R1-15 | Polish | **Fixed-verified** | Step 1 shows 'path does not exist', no advance |
| HB-R1-16 | Minor | **Fixed-verified** | Chat pill no longer over terminal text (terminal now 48×8 on iPhone 14) |
| HB-R1-17 | Polish | **Fixed-verified** | Crumbs 44 px, Keys/^C/^D ≥32 px, log rows 67 px |

Details: [homebase-r1-retest.md](homebase-r1-retest.md). No new bugs; HB-R1-18 (chunk 431 ChunkLoadError) not reproduced, so not filed.

## HB-R1-01 — Access "Add control" dialog: no focus move, no Escape, not modal · Minor
Steps: Home Access → Add control → press Tab / Escape.
Expected: focus moves into the dialog, Escape closes it, `aria-modal="true"` with focus trapped.
Actual: focus stays on the trigger behind the overlay; Escape does nothing; `role=dialog` without `aria-modal`.
Screens: `desktop-f-access-add.png`, `desktop-f-access-after-escape.png`, `phone-f-access-add.png`

## HB-R1-02 — "Add app" wizard ignores Escape · Polish
Steps: Apps → Add app → press Escape.
Expected: wizard closes (it is `aria-modal`). Actual: stays open; only the Close button works.
Screens: `desktop-f-apps-add.png`, `desktop-probe-apps-after-close.png`

## HB-R1-03 — Closed Notifications drawer is still focusable · Minor
Steps: Dashboard with drawer closed → press Tab repeatedly.
Expected: hidden drawer is inert / not in tab order. Actual: drawer keeps `role=dialog aria-modal=true` and Tab lands on off-screen History, Close, Mark all read, Read, Clear history (invisible focus).

## HB-R1-04 — "Sign out?" confirm: no initial focus, no Escape, no dialog role · Polish
Steps: Settings → Session → Sign out → press Escape.
Expected: dialog role, focus on Cancel, Escape cancels. Actual: plain overlay div, focus stays on the Sign out trigger behind it, Escape leaves it open.
Screens: `desktop-s-signout-confirm.png`, `phone-s-signout-confirm.png`

## HB-R1-05 — Terms/Privacy doc modal ignores Escape · Polish
Steps: Settings → About & legal → Terms of Use → press Escape.
Expected: modal closes. Actual: stays open (modal is `aria-modal`, no key handler).
Screen: `desktop-s-terms-after-escape.png`, `phone-s-terms-after-escape.png`

## HB-R1-06 — Background calls keep firing after sign-out (401 console errors) · Minor
Steps: sign in → Settings → Session → Sign out → stay on login screen ~10 s with DevTools open.
Expected: activity/presence pollers stop on logout; clean console.
Actual: `POST /api/activity` and `POST /api/presence/heartbeat` keep returning 401 (2 each in ~10 s), logged as console errors. (Web client pollers, not the excluded presence desktop window.)
Screen: `desktop-s-after-signout.png`

## HB-R1-07 — Files "Are you sure?" write confirm focuses Save, not Cancel · Polish
Steps: Files → open a file in the scratch folder → edit → Save.
Expected: safe default (Cancel) focused for an overwrite. Actual: the confirm button is focused, so Enter overwrites.
Screen: `desktop-f-files-saved.png`

---
# Part 2 — deeper runtime pass (2026-11-11, ~12:45–1:20 AM America/New_York, served v1.17.4)

## HB-R1-08 — Reload on Work → Files crashes the whole UI, and the crash is sticky · Major
Steps: sign in → Work → Files → press browser reload.
Expected: Files view restored. Actual: "Something went wrong — Minified React error #310" (hooks order). Opening the URL again crashes again (last place is saved in `localStorage` `hb-work-place:*`). On desktop the in-page Reload button recovered once; on iPhone 14 it did not. Only clearing that storage key recovers. Seen once on Work → Shell too.
Screen: `desktop-p2-crash-reload-files.png`

## HB-R1-09 — Unsaved file edits are silently thrown away · Major
Steps: Files → open a file → type (title shows "•") → click the Apps tab (or Home), or reload.
Expected: "Discard unsaved changes?" prompt / `beforeunload`. Actual: no prompt, view switches, edit is gone (not saved, not kept when you come back). Reload also shows no warning.
Screens: `desktop-p2-f-dirty.png`, `desktop-p2-f-dirty-apps.png`

## HB-R1-10 — Logs filters Server / Web / Cursor always show "No log lines yet" · Minor
Steps: Logs → pick Server, Web or Cursor. Actual: empty while All has ~220 lines. `/api/trace` sources are `client`, `pty`, `presence`, `boot`, so none match the filter values (`server`/`web`/`cursor`). Expected: filters match real sources.
Screen: `desktop-p2-logs.png`

## HB-R1-11 — Logs flooded with "client log ready" · Minor
211 of 224 lines in the 300-line ring are `CLIENT INFO client log ready`, logged about every 13 s per open tab, so real lines quickly drop out of the buffer.
Screen: `desktop-p2-files-save-fail.png` (shows the Logs view)

## HB-R1-12 — Home Access Save double-click creates duplicate controls · Minor
Steps: Access → Add control → fill Label → double-click Save. Actual: 2× `POST /api/home-access/widgets` → two identical controls. Expected: button disabled while saving (Files Save and Add app already do this — 1 request).
Screen: `desktop-p2-access-added.png`

## HB-R1-13 — API hiccup at load shows the Legal gate again and it sticks · Minor
Steps: block `/api/legal` + `/api/auth/status` (Playwright abort) → reload → unblock. Actual: "Before you continue, you must agree…" (as if never accepted); still shown 8 s after the API is back; only a manual reload fixes it. Expected: a connection error with retry, not a re-acceptance prompt.
Screen: `desktop-p2-api-down.png`

## HB-R1-14 — Back/forward and URLs don't follow the app · Minor
In-app navigation adds no history entries, so the browser/phone Back button leaves Home Base (to the previous site or a blank page). Every path (`/settings`, `/files`, `/does-not-exist`, `#/settings`, `?tab=logs`) returns 200 and shows the last-used screen, so there are no deep links and no 404.

## HB-R1-15 — Add-app wizard accepts a missing folder until the last step · Polish
Steps: Apps → Add app → path `…/does-not-exist` → Continue (enabled) → Own project → Add app. Actual: only then a 400 "does not exist or is not a directory". Expected: check the path on step 1.
Screen: `desktop-p2-w-badpath.png`

## HB-R1-16 — Phone: floating Chat button covers terminal and editor content · Minor
iPhone 14: the "Chat" pill sits on top of the terminal's last lines/prompt and the editor text; the terminal is only 48×12.
Screens: `phone-p2-L-shell.png`, `phone-p2-L-files-editor.png`

## HB-R1-17 — Phone: small tap targets · Polish
Below 32 px on iPhone 14: breadcrumb crumbs (Files), Keys / ^C / ^D (Shell), "Copy line" (Logs).
