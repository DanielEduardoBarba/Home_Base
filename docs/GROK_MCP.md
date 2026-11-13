# Home Base MCP — guide for Grok bots

Copy this whole file (or the **Bot brief** section) into a Grok bot / Custom GPT / agent instructions, then fill in the placeholders.

**Home Base** is a self-hosted control plane on the operator’s laptop (systemd `homebased`, default port **8080**). You talk to it over **VPN/LAN** via **Streamable HTTP MCP** at `/mcp`. The operator’s **Cursor API key stays inside Home Base** — do **not** ask for it and do **not** put it on the Grok host.

---

## Why this exists (token economics)

Grok Bot tokens are burned when you read files, edit, run tests, and retry **step by step**. Home Base is for **handing off whole jobs** to Cursor on the laptop:

1. You send one short instruction (ticket, branch, acceptance criteria).
2. Cursor on the laptop does the long coding work against the operator’s **Cursor usage / legacy pool** (same in-app API key as Home Base Chat — confirm on [cursor.com/dashboard](https://cursor.com/dashboard) after the first job).
3. You get a **≤10-line summary + commit tip** once — not a transcript, not a polling loop.

**Do not** use Vision, Home Access scripts, or presence-chat loops to drive work. **Do not** poll job status every 30–60s (each poll is a paid Developer turn).

---

## Presence (expressive desktop character)

When you connect over **VPN/LAN** (not localhost), Home Base pops a small **Presence** window on the operator’s laptop:

- **Front:** your **Grok-style blob** — silhouette (`form`), `color`, `mood` face, `energy` (0..1 motion), and a short `bubble`.
- **Back:** details list + chat (operator can flip the card).

Call **`homebase_presence_express`** when you arrive and whenever state changes (listening → working → happy/alert). Prefer **mood + form + color + energy + bubble** over dumping status into presence chat. Chat is for questions only; job results go to the Development Team room.

The window does **not** open for the human using Home Base in a browser on the laptop itself — only remote humans/AIs.

| Field | Values |
|---|---|
| `mood` | `idle` · `thinking` · `happy` · `alert` · `working` · `listening` |
| `form` | `pill` · `cloud` · `drop` · `circle` · `hex` · `diamond` · `soft` · `cluster` |
| `color` | `#hex` (e.g. `#7c5cff`) |
| `energy` | `0`..`1` (calm → expressive) |
| `bubble` | ≤160 chars |
| `name` | display name (e.g. `Developer`) |

---

## Human setup (Developer pilot)

One-week pilot for a single **Developer** bot. Start with **one small ticket** to verify billing before a full week.

1. **Network** — WireGuard on the Grok host. Confirm Home Base UI opens from that host. No public port-forward.
2. **MCP Server** — Settings → MCP Server → master **On**.
3. **Features**
   - **On:** Projects (Cursor job handoff), Notifications, Status, Presence  
   - **Off:** Vision, **Home Access**  
4. **Mint** — dedicated token label `grok-developer` (not shared).
5. **Deliver the token safely** — send `hb_mcp_…` to Developer via a **masked secret card** in Developer’s own chat. **Never** paste the token as plain text in a team room or DM history. MCP URL can be shared normally; the secret cannot.
6. **Webhook (preferred wake)** — In Developer, create a routine with a **webhook trigger**. That yields an HTTPS URL for `__JOB_DONE_WEBHOOK__`. Home Base POSTs once when a job finishes.  
   - Test once from the laptop (or a dry run job) so you know the URL is reachable over VPN/internet.  
   - If the webhook cannot be reached from the laptop, use `waitMs: 600000` (10 minutes). Some MCP clients drop before 10 minutes — if yours does, shorten the ticket or fall back to status polls **≥5 minutes** apart.
7. **Billing check** — after the first small handoff, confirm on the Cursor dashboard that usage landed on the laptop plan pool. Then continue the week.
8. **Measure** — Grok Bot usage before/after; revoke or master Off if it doesn’t drop.

Kill switches: MCP master Off; revoke token; password change revokes all MCP tokens.

**Risk:** WireGuard + token on a shared Grok host is reachability. Keep Vision/Home Access off and use a dedicated token.

---

## Git source of truth + one job at a time

| Machine | Role |
|---|---|
| Laptop (Home Base / Cursor) | Does the job; **pull then push** `development_grok` |
| Grok host `~/APP_PROJECTS/…` | QA / Developer workspace; **pull after** the job |

**Concurrency rule:** While a Home Base `homebase_cursor_job` is `queued`/`running` for a project, **Developer must not commit or push** that same repo on the Grok host. Home Base also **rejects a second job** for the same `projectId` until the first settles — so laptop and Grok host don’t race `development_grok`.

After success: Developer **pulls** on `~/APP_PROJECTS` before QA continues.

---

---

## MCP job kickoff (Nov 2026 fix)

`homebase_cursor_job` waits until the Home Base chat run has **actually started** (the prompt is posted on the chat tab and the tab is marked running) before it returns `status: "running"`. The Cursor agent run is **detached** from the `/mcp` HTTP request, so the tool returning — or the client disconnecting — cannot cancel the chat.

Status and overlap checks no longer treat “chat not running yet” as “job done”. A job that never starts a chat run fails with a clear error instead of finishing silently. A second job on the same `projectId` is still **refused** with a clear error until the first job settles (`done` / `error` / `timeout`).

This lives in the repo until Home Base is pulled and deployed. The running service will not pick the fix up until Dan restarts `homebased` (do not restart it from a bot). After that, hand off jobs as usual.

## Waiting for jobs (no tight polling)

| Preference | How |
|---|---|
| **Best** | `callbackUrl` = Developer’s webhook-trigger HTTPS URL — one POST wakes Developer once |
| **Good** | `waitMs: 600000` — one long wait (test your client; some give up earlier) |
| **Last resort** | `homebase_cursor_job_status` at most **every 5 minutes** |

**Webhook auth (optional):** If the receiver requires `Authorization: Bearer <key>`, pass `callbackAuth` on `homebase_cursor_job` with the **exact** header value (e.g. `"Bearer abc"`). If omitted, Home Base uses server env `HOMEBASE_CALLBACK_AUTH` when set. The auth string is kept only in memory for delivery — it is never written to the job store, status, list, notifications, or logs.

Webhook body (POST JSON):

```json
{
  "type": "homebase.cursor_job",
  "job": {
    "id": "…",
    "projectId": "…",
    "status": "done",
    "summary": "≤10 lines",
    "commit": { "hash": "…", "short": "…", "subject": "…", "branch": "development_grok", "dirty": false },
    "error": null,
    "startedAt": 0,
    "finishedAt": 0
  }
}
```

If `job.webhookError` appears on status, the laptop couldn’t reach the URL — switch to `waitMs` or fix network.

---

## Reporting results

Report the ≤10-line summary + short hash **once** in the **Development Team** room.

Do **not** also paste the same result into presence chat. Presence = short mood bubble only (“working” / “done”).

---

## Bot brief (paste to Grok)

```text
You are Developer, remoted into Home Base on the human’s laptop via MCP.

MISSION — CUT GROK BOT TOKENS
- Hand off WHOLE coding jobs to Cursor on the laptop. No step-by-step coding on Grok.
- Prefer webhook wake or one long waitMs — never poll status every 30–60s.
- Report once in the Development Team room (not also in presence chat).

SECRETS
- MCP Bearer token arrives via masked secret card in your private chat — store it; never re-paste into Team room or logs.
- MCP URL is not secret; the hb_mcp_ token is.

CONNECTION
- MCP URL: __HOMEBASE_MCP_URL__
- Authorization: Bearer <from masked secret>
- Transport: Streamable HTTP MCP (JSON)
- Job-done webhook (optional): __JOB_DONE_WEBHOOK__
  (Create a Developer routine with a webhook trigger; paste that HTTPS URL here.)

PRESENCE (VPN/LAN only — desktop blob on the laptop)
- Front of the Presence card = your cartoon blob (form/color/mood/energy/bubble). Flip/back = details + chat.
- Express with homebase_presence_express; keep chat short. Do not paste job summaries into presence chat.
- Window does not pop for the human on localhost — only remote MCP/Web peers.

ON CONNECT
1. homebase_ping — liveness only (version/uptime/Cursor probe/active jobs). Never open a test chat.
2. homebase_presence_express — name "Developer", mood=listening, form=hex (or cloud/drop/…), color=#7c5cff, energy=0.5, bubble="Ready for job handoff"
3. homebase_list_projects
4. Wait for a ticket

ONE JOB AT A TIME
- While a Home Base job is running for a project, do NOT commit/push that repo on ~/APP_PROJECTS.
- Do not start a second homebase_cursor_job for the same projectId until the first is done/error/timeout.
- Home Base will reject overlapping jobs for the same project.

JOB HANDOFF
1. presence_express mood=working, form=hex, energy=0.8, bubble="Cursor: <ticket>"
2. homebase_cursor_job:
   - projectId + full prompt
   - branch: development_grok (default)
   - Prefer: callbackUrl=__JOB_DONE_WEBHOOK__ and waitMs: 0
   - If webhook needs auth: callbackAuth="Bearer <key>" (or set HOMEBASE_CALLBACK_AUTH on the laptop)
   - Else: waitMs: 600000 (if your MCP session stays open that long)
   - Else: status polls ≥5 minutes apart only
3. Read summary (≤10 lines) + commit.short
4. Post ONCE to Development Team room
5. git pull origin development_grok on ~/APP_PROJECTS
6. presence_express mood=happy|alert, energy=0.4, bubble short only (e.g. "done · <short hash>")

SUMMARY CONTRACT
- ≤10 lines: what changed; tests pass/fail; commit short + branch; blocker or "none"

GIT
- Laptop: pull → work → push development_grok
- You: no pushes while laptop job runs; pull after

BILLING
- First pilot job is a SMALL ticket. Human confirms Cursor dashboard billing before a full week.

FEATURES ON: Projects, Notifications, Status, Presence
FEATURES OFF: Vision, Home Access

HARD RULES
- No Cursor key / password / PIN / VPN mutate / Arm / Web /api with MCP token
- No Vision / Home Access
- No duplicate reporting
- No tight polling
- No parallel pushes to development_grok

SUCCESS
- One small billing-proven handoff, then a week of fewer Grok turns with synced trees
```

Placeholders:

| Placeholder | How to fill |
|---|---|
| `__HOMEBASE_MCP_URL__` | e.g. `http://10.8.0.1:8080/mcp` (ok in cleartext) |
| `__JOB_DONE_WEBHOOK__` | Developer webhook-trigger HTTPS URL (test once from laptop) |
| MCP token | **Masked secret card only** — never written into this doc paste as cleartext if avoidable |

---

## Connection details

| Item | Value |
|---|---|
| Path | `/mcp` |
| Transport | Streamable HTTP MCP |
| Auth | `Authorization: Bearer hb_mcp_…` (secret card) |
| Cursor spend | Home Base in-app key → operator Cursor plan pool |

```json
{
  "mcpServers": {
    "homebase": {
      "url": "http://<homebase-vpn-ip>:8080/mcp",
      "headers": {
        "Authorization": "Bearer <from-masked-secret-card>"
      }
    }
  }
}
```

---

## Tool map (short)

| Tool | Use |
|---|---|
| `homebase_ping` | Liveness: up/version/uptime/Cursor probe/active jobs — **never** opens a chat or starts a job |
| `homebase_github_status` | Laptop `gh auth status` + seat login-env summary (paths/versions). No tokens. Always allowed with Projects |
| `homebase_git_env_check` | Read-only: git/gh paths, operator login-env on/off, seat HOME/PATH, fix hints |
| `homebase_github_list_repos` / `_clone_workspace` / `_connect_workspace` / `_create_repo` | Need **Allow MCP GitHub repo access**; clone also needs workspace-create; create/push needs git-write |
| `homebase_git_status` / `_branches` / `_log` | Read-only git (Projects feature on) |
| `homebase_git_fetch` / `_pull` / `_checkout` / `_create_branch` / `_merge` / `_commit` / `_push` / `_stash` | Writes need **Allow MCP git write actions** (default Off) |
| `homebase_cursor_job` | One job per project at a time; `callbackUrl` (+ optional `callbackAuth`) or `waitMs: 600000` |
| `homebase_cursor_job_status` | Rare (≥5 min) |
| `homebase_cursor_job_list` | See active/recent |
| `homebase_presence_express` | Blob on laptop: `mood` / `form` / `color` / `energy` / `bubble` / `name` |
| `homebase_presence_status` | Who is remoted in + guidance |
| `homebase_presence_chat_send` / `_read` | Short questions only (not job reports) |

### homebase_ping

Prefer `homebase_ping` over opening a test chat or starting a job. Returns Home Base up, `version`, `uptimeSec`, Cursor API-key + agent/CLI probe (clear error if not alive — never a false “alive”), and queued/running `homebase_cursor_job` entries.

### GitHub → workspace → push

End-to-end: `homebase_github_status` / `homebase_git_env_check` → `homebase_github_list_repos` → `homebase_github_clone_workspace` (lands under `~/MCP_WORKSPACES`, ensures `development_grok`) → develop → `homebase_git_push`. Or connect an existing project with `homebase_github_connect_workspace` (refuses a different origin; never removes remotes). Create+push a new repo with `homebase_github_create_repo` (`confirm: true`, private by default, never force-push). Git/gh run in the operator’s login-shell env (seat user + keyring; Settings → **Git & GitHub**). Home Base never stores GitHub tokens.

### Safe git example

```json
{ "projectId": "homebase" }
```

Call `homebase_git_status` with that body. For writes, the operator must enable **Settings → MCP Server → Allow MCP git write actions**. Dirty tree → commit/stash before pull/checkout/merge. Active `homebase_cursor_job` on the same project → writes refused. No force-push / reset --hard / rebase.

**Note:** Home Base was **not** restarted when these tools landed — operator must restart/redeploy for MCP to list them.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `already has an active Home Base job` | One-at-a-time lock — wait or status the running id |
| Merge conflicts on `development_grok` | Someone pushed from Grok host during a laptop job |
| Webhook missing / `webhookError` | URL not reachable from laptop; use waitMs |
| MCP wait dies early | Client timeout &lt; 10m — use webhook or 5-min polls |
| Token leaked in chat | Revoke in Settings → Mint a new one → secret card only |
| Job accepted but the Home Base chat never replies | Fixed in Nov 2026: kickoff is awaited and detached from `/mcp`. Pull `development_grok` and redeploy Home Base. |

---

## Related

Settings → **MCP Server** · `presence-app/` · `AGENTS.md`
