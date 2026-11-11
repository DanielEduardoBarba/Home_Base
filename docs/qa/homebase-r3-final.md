# Home Base — R3 final regression (local)

- **When:** 2026-11-11, 6:45–6:48 PM America/New_York (EST).
- **Build tested (already up, not restarted):** v**1.17.7**, process since 4:46 PM EST from `~/APP_PROJECTS/Home_Base/server/src/entry.ts`. Product merge **1c307eb** (PR #10). Served chunk **`page-67e2e9fb45a84d03.js`**. Local `development_grok` HEAD was **6388709** (prior QA docs) at the start of this pass.
- **How:** one Playwright script, `~/APP_PROJECTS/qa/e2e/homebase-r3-final.mjs` (desktop 1280x800), plus a single targeted recheck of HB-R2-01. Reports: `~/APP_PROJECTS/qa/reports/homebase-r3-final.json`. Scratch folder only. Start was not clicked.

## Verdict: pass. No new bugs.
The scripted HB-R2-01 check in the main pass failed because navigation never left the scratch folder. A single follow-up from Files → “Filesystem root (/)” → `root` showed the alert **“Permission denied — Home Base can't read /root”** (`role=alert`). Not a regression.

| Area | Result | Notes |
|---|---|---|
| Login / dashboard | Pass | Dashboard shows Agent, Work, v1.17.7 |
| Files save in scratch | Pass | Edited `empty.txt`; Save confirm focused Cancel (HB-R1-07) |
| HB-R1-09 unsaved-edits prompt | Pass | “Leave without saving?” when switching to Apps |
| HB-R2-01 / HB-R2-02 | Pass | Shortcut still reads “Filesystem root (/)”; denied folder shows the alert (follow-up) |
| HB-R1-08 reload on Files | Pass | No crash |
| Shell | Pass | `echo QA_R3_42` in the scratch folder; session then exited |
| Apps (read-only) | Pass | Seeded project visible; **Start not clicked** |
| Logs, Settings, Access | Pass | Logs filters present; Settings sections render |
| HB-R1-01 Access dialog | Pass | Focus moves into the dialog; Escape closes it |
| Logout | Pass | Returns to the password screen |

## Not tested
- Phone / tablet / 360 px layouts, keyboard-only, theme toggle, Notifications, invoice-style copy in the terminal, and the chunk-431 cold-load matrix (last checked 0/5 on 1.17.7 earlier today).
- Expected-fail list (Cursor chat/agents, View/Vision, WireGuard, Tunnel, presence window, systemd, email, sudo vault).

## Cleanup
The one QA shell session from this pass (6:47 PM) was deleted. Scratch `files/empty.txt` now ends with “r3” (QA-only). No apps or Access controls were added.
