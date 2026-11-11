# Home Base — Round 2 bugs (v1.17.5, 2026-11-11 America/New_York)

Severity: Blocker > Major > Minor > Polish. Screenshots: `docs/qa/screenshots/homebase-r2/`.

| ID | Severity | Summary | Status (latest retest) |
|---|---|---|---|
<!-- 01–05 verified on v1.17.6 (1e3d85f) -->
| HB-R2-01 | Minor | Opening an unreadable folder (`/root`) does nothing, with no message | **Fixed-verified** |
| HB-R2-02 | Polish | The "/ root" shortcut means the filesystem root but reads like the `/root` folder | **Fixed-verified** |
| HB-R2-03 | Polish | The phone shell key bar has no arrow keys | **Fixed-verified** |
| HB-R2-04 | Polish | Dashboard has an invisible Tab stop ("pull to refresh") with no focus ring | **Fixed-verified** |
| HB-R2-05 | Polish | At 360 px the Files subtitle runs off the screen | **Fixed-verified** |
| HB-R2-06 | Minor | Desktop: can't copy text out of the terminal (suspected — needs a manual check) | **Fixed-verified** on v1.17.7 (1c307eb) — see [homebase-r2-06-retest.md](homebase-r2-06-retest.md) |

## HB-R2-01 — Unreadable folder fails silently · Minor
Steps: Work → Files → click "/" in the path bar → click `root`.
Expected: a message such as "Permission denied — Home Base can't read /root".
Actual: nothing happens. The list stays on "/", and the only sign is `400 GET /api/projects/homebase/fs` in the console. A user can't tell whether the click registered. Desktop and phone.
Screen: `desktop-files-root-denied.png`

## HB-R2-02 — "/ root" shortcut label is ambiguous · Polish
Files → SHORTCUTS shows "/ root". It opens `/` (the filesystem root), while a real `/root` folder sits in the same list and can't be opened (HB-R2-01).
Expected: a label like "Filesystem /" or "Computer".
Screen: `desktop-files-root-denied.png`

## HB-R2-03 — Phone shell keys: no arrows · Polish
iPhone 14 → Shell → New shell → Keys. The bar offers Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+L, Esc and Tab.
Expected: ↑ ↓ ← → for command history and cursor movement; iOS keyboards have none. Common shell symbols (`|`, `~`, `/`, `-`) would also help.
Screen: `phone-shell-keys.png`

## HB-R2-04 — Invisible focus stop on the dashboard · Polish
Steps: Dashboard → press Tab. Agent → Work → Access → Vision → Settings, then focus lands on a "pull to refresh" element with no visible ring and no action.
Expected: the pull-to-refresh wrapper is not focusable (or is skipped).

## HB-R2-05 — 360 px: Files subtitle overflows · Polish
At 360×740 the line "Home Base files · /home/box/… — not Cursor's open editor" is wider than the screen; its text span ends past the right edge.
Screen: `narrow-L-files.png`

## HB-R2-06 — Copying text out of the terminal doesn't work (suspected) · Minor
Steps (desktop, v1.17.6): Shell → New shell → `echo QA_COPY_ME` → drag across the output line → Ctrl+Shift+C, then Ctrl+C.
Expected: the line is selected and copied, as in any terminal.
Actual (headless Chrome): no selection highlight appeared and the clipboard stayed empty. Ctrl+C was sent to the shell as an interrupt (a new prompt appeared). `Terminal.tsx` has no copy or selection handling.
Caveat: mouse selection in headless xterm can behave differently, so please confirm by hand in a real browser.
Screen: `desktop-rt-copy.png`
