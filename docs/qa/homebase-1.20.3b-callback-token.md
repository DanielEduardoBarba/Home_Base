# Home Base 1.20.3b — callback token vault, log redaction, restart callbacks

Developer note (not a QA pass). Build is on `development_grok`. **Keep VERSION 1.20.3. Not deployed.** Do not restart or touch the live Home Base server. This is the follow-up to 1.20.3 lockout recovery: move `HOMEBASE_CALLBACK_AUTH` into the encrypted vault, prove logs never store the token, and deliver an authenticated `interrupted` webhook if Home Base restarts mid-job (bots do not poll).

## What changed

### 1. Vault + Settings (item 1)

The default job-webhook `Authorization` value lives in the AES-256-GCM secrets vault (`callback_auth.enc` + `callback_auth.hint`, mode 0600), same pattern as the Cursor API key.

- Settings → **Job webhook auth**: set / replace / clear. The API (`GET`/`POST`/`DELETE /api/callback-auth`) and UI show only `secretDisplayHint` (first/last 4). The value is never returned.
- `resolveCallbackAuth`: per-job `callbackAuth` wins; otherwise the vault value. **`process.env.HOMEBASE_CALLBACK_AUTH` is never read for delivery.**
- If the env var is still set (typical leftover in `/var/lib/homebased/.env`):
  - On start, it is **one-time imported** into the vault when the vault is empty (existing vault values are not overwritten).
  - Settings shows a warning telling Dan to remove it from `.env`.
  - `/api/health` and `/api/system/status` expose **`callbackAuthEnvSet` (boolean only)** — never the value or hint on health.
- Soft reset keeps `callback_auth.enc` / `callback_auth.hint` with the other secrets. The pending-callback file is not a secret and is wiped on soft reset.

### 2. Log audit + central redaction (item 2)

Audit of log paths **before** this change:

| Path | What was written | Token values? |
| --- | --- | --- |
| `request_log.ts` | method, path, IP, status, ms, UA | No body or `Authorization` header |
| `mcp_http.ts` → activity | tool name + **arg keys only** (`argKeys`) | Key name `callbackAuth` could appear; values were not written |
| `activity_audit.ts` | `summary` + `detail` as provided | Safe today (keys only); would have stored values if a caller passed them |
| `logging.ts` (`appendDaily`) | event + fields | Auth failures log reason/IP, not Bearer values |
| `trace.ts` / `console_log.ts` | message + fields | Cursor job webhook errors were already passed through `redactCallbackSecrets` |
| `security_log.ts` | already ran `redactSecrets` on the message | Covered MCP tokens, Bearer, JWT, password/key patterns |
| `notifications.ts` | title / body / meta as provided | No callback auth was passed in |
| Job status / list / public job JSON | job fields | Auth lived only in the in-memory `callbackAuthByJobId` map |

Central redaction (`server/src/redact.ts`) is now applied at every sink: `appendDaily`, `appendTrace`, `recordActivity`, `log()`, `pushNotification`, and `security_log`. It redacts sensitive **keys** (`callbackAuth`, `authorization`, `token`, `apiKey`, `password`, `secret`, …) and **values** (Bearer, `hb_mcp_`, JWT, `password=` / `api_key=` / `callbackAuth=`, PEM).

### 3. Restart mid-job (item 3, QA catch)

Jobs themselves stay memory-only. When a job with `callbackUrl` starts, Home Base writes `cursor_callbacks.pending.enc` (mode 0600) with `jobId`, `projectId`, `callbackUrl`, `startedAt`, `hasAuth`, and `authEnc` (`encryptSecret` — never plaintext). The record is deleted after the webhook is delivered or after the final failure/retry (today: one attempt).

On Home Base startup (the long-running server path only — not `unlock` / `--self-test`):

- For each leftover record: decrypt auth, POST status `interrupted` with summary `Home Base restarted while this job was running; the job did not finish`, **Authorization intact**, then delete the record. The job also appears in `homebase_cursor_job_list`.
- Records older than 24 hours: logged (`pending cursor job callback <id> expired after 24h; not delivered`) and deleted. No webhook.
- If decrypt fails and `hasAuth` was set: log clearly, **do not** POST an unauthenticated webhook, and record a lost-callback entry (status `error`, `callbackAuthExpected: true`, `webhookError` explaining the decrypt failure) visible in `homebase_cursor_job_list`.
- If no auth was ever set (`hasAuth: false`): notify without an `Authorization` header.

A boolean `callbackAuthExpected` may appear on public job JSON; the secret itself never does.

## R8b procedure

Run this on a QA box / local stack, **not** against the live laptop Home Base. Use a **dummy** token only (`Bearer r8b-dummy-callback-token-XYZ123-unique` or similar). Never paste a real webhook secret into logs or this doc.

1. **Vault field.** Sign in to Settings → Job webhook auth. Save the dummy token. Confirm the page shows only a first/last-4 hint and never echoes the value. Reload: still hint-only. Remove, then set again.
2. **Env warning.** With the vault set, put `HOMEBASE_CALLBACK_AUTH=<dummy>` in the test `.env` / process env and reload Settings / `GET /api/health`. Expect `callbackAuthEnvSet: true` (boolean only — the health JSON must not contain the dummy token) and the Settings warning. Remove the env var: the warning and flag go away; delivery still uses the vault.
3. **Env is not used for delivery.** With the env var set to token A and the vault set to token B, start a `homebase_cursor_job` with `callbackUrl` and no `callbackAuth`. The webhook `Authorization` header must be token B, not A. A per-job `callbackAuth` (token C) must win over both.
4. **Dummy-token search across all logs/runtime files.** After an MCP `homebase_cursor_job` that passed the dummy token as `callbackAuth`, search the entire runtime directory (logs, activity, traces, notifications, vault files, `cursor_callbacks.pending.enc`, hints):

   ```bash
   # Replace NEEDLE with the unique middle of the dummy token (not "Bearer" alone).
   grep -R --binary-files=text -F 'r8b-dummy-callback-token-XYZ123' "$HOMEBASE_RUNTIME"
   ```

   Expect **no hits**. Automated coverage: `PATH=$HOME/.bun/bin:$PATH bun test test/unit/callback_auth_r8b.test.ts` (env-isolated; skipped in the combined `bun test test/unit` run).
5. **Restart mid-job.** Start a job with `callbackUrl` + dummy `callbackAuth` and restart (or simulate by leaving the pending file and reloading the module) **before** the job finishes. Expect a POST with status `interrupted`, the exact summary above, and the **exact** dummy `Authorization` header. The pending file must be gone afterwards. Repeat the grep: still no plaintext token.
6. **Lost / expired (optional but covered by unit tests).** A corrupt `authEnc` must not send an unauthenticated webhook and must show a lost-callback row in `homebase_cursor_job_list`. A record older than 24h is logged and not delivered.

## Automated tests

Env-isolated file `server/test/unit/callback_auth_r8b.test.ts` (run alone):

- Central redaction of `callbackAuth` / Bearer / keys
- MCP `homebase_cursor_job` + activity/daily/trace/notification sinks: dummy token grep of all runtime files is empty; pending file is 0600 and then removed after delivery
- Module-reload restart: interrupted callback arrives with exact auth; record removed; grep empty
- 24h expiry: logged, not delivered
- Decrypt failure: lost-callback list entry; no unauthenticated POST
- No-auth pending record: interrupted POST without `Authorization`

Also: `secrets_vault.test.ts` (set/clear/hint/env boolean/one-time import) and updated `cursor_jobs.test.ts` (vault default, env ignored, param wins, `callbackAuthExpected` without the secret).

## Upgrade notes

No VERSION bump (stays 1.20.3). After deploy (later, when Dan holds the green light): if `HOMEBASE_CALLBACK_AUTH` is in `/var/lib/homebased/.env`, first start imports it into the vault if empty and keeps warning until the line is removed. Existing in-flight jobs started before this build have no pending file; a restart of those would still drop the webhook (same as 1.20.3). Jobs started after this build get the interrupted callback.

## Security trade-offs

- Pending file is JSON with an `authEnc` blob, not a single ciphertext wrapping the whole list. Job ids and callback URLs are readable to anyone who can read runtime files (root / homebased). The token is not. File mode is 0600.
- Interrupted webhooks fire once on startup even if the original job might have continued in a racing process (there is only one `homebased` unit). A failed interrupted POST is not retried on the next start (the record is already deleted) so a bot could still wait if the receiver was down at that moment — same one-shot behavior as a normal finish webhook.
- Health exposes only the boolean env warning, not whether a vault token is configured (avoids advertising a secret's presence on an unauthenticated endpoint).
