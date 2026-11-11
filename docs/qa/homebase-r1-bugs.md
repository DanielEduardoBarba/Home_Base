# Home Base — Round 1 bugs (2026-11-11, America/New_York)

Severity: Blocker > Major > Minor > Polish. All repro on desktop 1280x800 and iPhone 14 unless noted.

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
