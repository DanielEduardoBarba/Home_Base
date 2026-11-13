# Home Base 1.20.0 — PIN lockout, MCP lockout split, Security

Developer note (not a QA pass). Build is on `development_grok`. **Not deployed.** Live 1.19.x is unchanged until Dan self-deploys.

## Root cause (live 1.19.x, 2026-11-13)

At **01:38 AM ET** (06:38 UTC) the human lockout file was filled by **18 `invalid_mcp_token` failures** in about 40 seconds (`failCount` 10–18, final delay **86400s**). Notifications:

- 06:38:12Z, 06:38:21Z, 06:38:51Z — bursts of "Auth lockout / invalid_mcp_token from **unknown**"
- 06:38:28Z and 06:38:58Z — security monitor "Repeated login failures … lockout active (~86392s)"
- A valid connector **Grok Bot Access** from **10.6.0.5** connected at 06:33:20Z, **06:38:35Z** (between bursts), and 06:43:47Z

**Evidence and verdict for the 1:38 AM source:**

| Field | What we have |
|---|---|
| Time | 06:38:12–06:38:51 UTC (01:38 AM ET), 18 failures, often in groups of 3 (typical MCP initialize/list/call or a short retry) |
| IP | Logged as **`unknown`** — `verifyMcpBearerToken` received no socket address. This is a capture gap (fixed in 1.20.0). We cannot prove the peer IP from the log. |
| User agent | **Not recorded** on 1.19.x failure events (fixed in 1.20.0). |
| Token id / label | **Not recorded** (and the secret must never be). Failures were `invalid_mcp_token`, so the presented secret did not match any hashed connector. |
| Nearby valid client | Named connector **Grok Bot Access**, WireGuard-side **10.6.0.5** (DevCon1 Developer box), successful MCP presence in the same minute. |

**Verdict:** this was an **MCP bot client with a bad or stale token**, not a human typo on the PIN pad. We **cannot honestly name a specific connector or swear the IP was 10.6.0.5**, because the IP and user agent were not stored. Circumstantial timing sits next to the DevCon1 Grok Bot on 10.6.0.5, but the failed attempts must be classified as **unknown / unattributed** until 1.20.0 attribution is live. Box `hb.sh` is a single-call client (it did not loop); 18 failures imply several calls or another client retrying.

## Unlocking live 1.19.x right now (do not skip the timer in software from here)

The human lockout started at **01:38:51 AM ET** and lasts **24 hours**, so it lifts at about **01:38 AM ET on Saturday, Nov 14, 2026** (America/New_York). Until then, the correct PIN and the correct password are both rejected by `assertNotLocked()`.

Safe existing ways to clear it, **not done here**:

1. Wait until that time, then sign in with the password or PIN.
2. On the Home Base host, remove or reset `.runtime/lockout.json` (this is the live lockout file). That is a host-file change for Dan, not something this bot should do.
3. A Settings soft reset also deletes `lockout.json`, but it clears other runtime files too — heavier than needed.

Password login will show the lockout once 1.20.0 is deployed; on 1.19.x the PIN pad still only shakes.

## What 1.20.0 changes

See `docs/QA-PROGRESS.md` and `docs/HOMEBASE-MCP-GUIDE.md` (connector refresh section). QA should retest the PIN pad (wrong PIN, lockout message, password path, stale session), MCP 401 codes, refresh reuse revocation, and Settings → Security after Dan deploys.

## Follow-up

Cookie-session and WebSocket ticket work landed in **1.20.1** — see `docs/qa/homebase-1.20.1-session-ws.md`. Do not deploy 1.20.0 alone; use 1.20.1.
