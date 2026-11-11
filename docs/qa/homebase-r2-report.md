# Home Base — QA Round 2 (first-time-user pass)

- **When:** 2026-11-11, ~1:44–1:58 AM America/New_York (EST).
- **Build:** v1.17.5, `development_grok` 674da3d, :8090.
- **How:** headless Playwright on desktop 1280x800, tablet 768x1024, narrow phone 360x740 and iPhone 14.
  - Scripts: `~/APP_PROJECTS/qa/e2e/homebase-r2.mjs` and `homebase-r2-extra.mjs`.
  - Reports: `~/APP_PROJECTS/qa/reports/homebase-r2-*.json`.
- **Not logged:** the expected-fail list (Cursor chat and agents, View/Vision, WireGuard, Tunnel, presence window, systemd, email, sudo vault). Those Settings rows were not opened.

## Verdict
Stable and consistent, with no dead buttons and no crashes. The only runtime error was the 400 behind HB-R2-01. I found 5 new bugs (1 Minor, 4 Polish); see [homebase-r2-bugs.md](homebase-r2-bugs.md). The main weakness is copy: a lot of insider jargon for a first-time user (see below).

## Coverage
| Area | Result | Notes |
|---|---|---|
| Clean-browser first run | Pass | Legal is accepted on the server (v1), so a fresh browser goes straight to login, then the dashboard |
| Every control on Dashboard, Apps, Logs, Access, Agent | Pass | Each safe control was clicked in a sweep (destructive, Start and expected-fail controls skipped). None had no visible effect |
| Notifications | Pass | Clear empty state ("Inbox empty — New alerts toast here…"); History lists the 2 read security alerts |
| Settings rows, one by one | Pass | Opened Appearance, Server name, AI usage, Setup, App PIN, Activity history, Share & password, MCP Server, Services, Notifications, Storage, Session and About & legal (view only; Reset, Erase and Restart not touched) |
| Data accuracy | Pass | All match the box: version v1.17.5 = `/api/health`; server name; session "~23h left" = 86400 s token; LAN `172.30.0.2` and VPN `10.6.0.5` = `ip a`; QR host `grok-bot-vm-405592944.local` = hostname. There are no disk or uptime widgets |
| Apps seeded project (read-only) | Info | No detail tabs, logs or config view exist. Only Run/Ship pickers and a link to `http://127.0.0.1:8080/`, which opens a dead page when the dev server isn't running. Start not clicked |
| Shell | Pass | Two sessions at once, with Exit/Kill each. Paste with Ctrl+Shift+V and Ctrl+V works. There is no rename. Phone keys: HB-R2-03 |
| Files | Partial | Nested folders, breadcrumbs (44 px on phone), and a large folder (`/usr/lib`, about 2.5 s) all fine. Unreadable folder: HB-R2-01 and HB-R2-02 |
| Tablet 768 / narrow 360 | Pass | No page overflow except HB-R2-05; the tablet dashboard uses a 2-column grid |
| Dark/light theme | Pass | Day theme readable on dashboard, Files and Logs; reverted to Night |
| Keyboard only | Pass | Login: Password → Show → Enter. The 404 page focuses "Back to Home". Dashboard cards are reachable and open with Enter. Files path bar is in the Tab order. Invisible stop: HB-R2-04 |

## UX findings (copy and first-time clarity, not filed as bugs)
1. **Login says little.** "Control plane for your workspaces" with a single password field. There is no hint where the password comes from and no "forgot password" route. The footer "AS IS — use at your own risk" is the most prominent sentence.
2. **Insider jargon:**
   - Dashboard: "Control plane", "the full laptop control plane", "Arm to let the agent drive mouse and keyboard on Ubuntu X11".
   - Shell: "No PTY sessions. Start a stack from Apps".
   - Files: "— not Cursor's open editor".
   - Logs: "Shared ring · max 300".
   - Shell session rows: "shell shell · pid 1175020".
   - Apps: "Deploy self", "Build + safe install + restart service".
   - AI usage: "Legacy Cursor (Pro / Pro+ / Ultra) vs The X Subscription … MCP Grok bots".
   - Settings → Notifications: the "Ping sound" hint says "Short beep when Cursor finishes…".
3. **Dashboard has no next step for a new user.** It shows five cards with "Open →" and no "add your first app" or getting-started hint. Opening `/` returns to the last area, so a returning user may never see the dashboard.
4. **Apps:** the seeded project's `:8080` link looks live even when the app isn't running.
5. **Storage scene:** "Reset data" and "Erase everything" sit side by side. Each is guarded, but the descriptions are terse.

## Cleanup and leftovers
- Theme reverted to Night (tablet and 360 runs).
- 3 QA shell sessions (1:45–1:48 AM) deleted.
- No settings saved, no apps or controls added, Start not clicked.
- Notifications: only History was opened.
- The scratch folder is unchanged since the R1 retest.
