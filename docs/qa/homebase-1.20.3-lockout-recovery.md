# Home Base 1.20.3 — local-seat lockout recovery

Developer note (not a QA pass). Build is on `development_grok`. **Not deployed.** Do not restart or touch the live Home Base server. This release is the follow-up to Dan clearing `/var/lib/homebased/.runtime/lockout.json` by hand after the 1.19.x shared lockout survived the 1.20.2 upgrade.

## What changed

### 1. Local-seat password recovery

A human using a browser on the same machine as the service can sign in with the **correct password** while the human lockout is active, and that success clears the lockout.

“Local” is decided **only** by the real socket peer address being loopback (`127.0.0.0/8`, `::1`, and IPv4-mapped `::ffff:127.x.x.x`). The bypass is **refused** when:

- Any forwarding header is present: `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `Forwarded`, `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP`
- `HOMEBASE_TRUSTED_PROXIES` is set (a local reverse proxy or tunnel would make outside traffic look like `127.0.0.1`)
- The peer is VPN/LAN (for example `10.6.0.5` or `192.168.x`), including IPv4-mapped `::ffff:10.6.0.5`
- The request carries an MCP, connector, or Bearer token
- The attempt is PIN-only (PIN still hits the human lockout)

The login request still has to pass the existing same-origin check. Only the human password login route qualifies.

Local attempts have their own backoff file (`.runtime/local_lockout.json`): 5 tries, then an escalating delay. A wrong local password never clears the human lockout and does not increment the remote counter. Remote attempts stay fully locked.

The login page, when the server reports `lockout.localSeatRecovery`, says a local password sign-in will clear the lockout and leaves the password field usable.

### 2. Security log

Every lockout clear writes a hash-chained `lockout_cleared` event with `method` (`local_password_signin`, `cli_unlock`, `upgrade_migration`, `expired`), `previousFailCount`, `previousLockedUntil`, socket IP, user agent, and path. Settings → Security has an event filter for **Lockout cleared** and shows method / previous fail count on the row.

### 3. Email alert

A lockout clear uses the existing email-alerts settings (no new secrets, no passwords or tokens in the body). Fields: method, time, previous fail count, source IP / device. If there is no configured recipient (or alerts are disabled), the clear is still logged and the gap is reported on the event and in `sudo homebase unlock` output.

### 4. `sudo homebase unlock`

Root-only CLI. Clears the human lockout; `--mcp` or `--all` also clears MCP lockouts. Prints the file path and previous fail count, writes `lockout_cleared` (`cli_unlock`), and emails or reports the recipient gap. Non-root is refused and leaves the file in place.

### 5. Upgrade migration

On first start of 1.20.3, if `lockout.json` has no `schemaVersion` marker (1.19.x shared file, and also unversioned 1.20.0–1.20.2 files), it is reset once with method `upgrade_migration` (logged; emailed when there was a real lock). New lockout files get `schemaVersion: 2`. A already-versioned 1.20.3 file is left alone.

### 6. HB-R7b-01

A 423 `pin_locked` now dispatches `hb-pin-lock` with the error payload. The PIN pad shows “App PIN required. Unlock with your PIN to continue.” and `HTTP 423 · App PIN required`. It does not look like a wrong PIN and does not send the user to password login.

### 7. `homebase_session_output`

Read-only MCP tool `{ projectId, sessionId, lines<=500 }` returns the recent tail of a PTY/session, with tokens, Bearer values, keys, and password patterns redacted. MCP auth required. Documented in `docs/HOMEBASE-MCP-GUIDE.md` (copied to `/home/box/shared/homebase/HOMEBASE-MCP-GUIDE.md`).

## Automated tests

All of the following live in `server/test/unit/lockout_recovery.test.ts` and must be run **individually** (`bun test test/unit/lockout_recovery.test.ts`) because the file is env-isolated. Together with the rest of `test/unit` they are skipped in a combined run (same pattern as `lockout.test.ts`).

### Local-seat eligibility refusals

1. Refuses bypass when `X-Forwarded-For` is present, even on loopback
2. Refuses bypass when `X-Forwarded-Host` is present, even on loopback
3. Refuses bypass when `X-Forwarded-Proto` is present, even on loopback
4. Refuses bypass when `Forwarded` is present, even on loopback
5. Refuses bypass when `X-Real-IP` is present, even on loopback
6. Refuses bypass when `CF-Connecting-IP` is present, even on loopback
7. Refuses bypass when `True-Client-IP` is present, even on loopback
8. Refuses bypass when `HOMEBASE_TRUSTED_PROXIES` is set, even on loopback with no forwarding headers
9. Refuses VPN peer `10.6.0.5`
10. Refuses LAN peer `192.168.1.50`
11. Allows IPv4-mapped loopback `::ffff:127.0.0.1`
12. Refuses IPv4-mapped VPN `::ffff:10.6.0.5`
13. Allows `::1`
14. Refuses a Bearer token even on loopback
15. Refuses an MCP connector Bearer token even on loopback
16. Refuses a raw `hb_mcp_` credential without Bearer
17. `X-Forwarded-For` spoof of `127.0.0.1` from a VPN socket is refused

### Local-seat password login vs PIN and backoff

18. Correct password from `127.0.0.1` clears the human lockout
19. Correct password from `::1` clears the human lockout
20. Correct password from `::ffff:127.0.0.1` clears the human lockout
21. Each forwarding header blocks a correct local password from clearing the lockout
22. `HOMEBASE_TRUSTED_PROXIES` blocks a correct local password from clearing the lockout
23. VPN and LAN peers with the correct password stay locked (`10.6.0.5`, `192.168.1.50`, `::ffff:10.6.0.5`)
24. Bearer / MCP / connector tokens cannot use the local bypass
25. PIN-only attempt cannot bypass an active human lockout
26. Wrong password from loopback counts toward local backoff and never clears the lockout
27. Exceeding the local try limit delays further local attempts (correct password still waits)

### Audit, email, migration, CLI, redaction

28. Successful local clear writes exactly one `lockout_cleared` event that verifies in the HMAC chain, and triggers one email alert (mocked)
29. A lockout clear with no email recipient still logs and reports the gap
30. Upgrade migration resets a legacy 1.19.x lockout file once, logs, and emails; a second migrate is a no-op
31. A versioned 1.20.3 lockout file is not migrated away
32. `sudo homebase unlock` as root clears human (and optionally MCP) lockouts, logs, and emails, and prints what it cleared
33. Non-root `homebase unlock` is refused and leaves the lockout in place
34. `redactSecrets` strips tokens, Bearer, keys, and password patterns
35. `takeLastLines` caps at 500 and `homebase_session_output` is a documented read-only tool (session-not-found path)

## QA procedure — upgrade over an existing 1.19.x lockout

Do this on a **throwaway** Home Base (separate `HOMEBASE_HOME` / port). Do **not** use the live service or real customer data.

1. Start from a copy that already has a **legacy** lockout file: `{ "failCount": 18, "lockedUntil": <now+86400> }` and **no** `schemaVersion` field, at `$HOMEBASE_HOME/.runtime/lockout.json` (mode 0600). This is the 1.19.x shared-lockout shape.
2. Optionally also write a `mcp_lockout.json` with one source, to prove MCP stays separate.
3. Boot **1.20.3** against that home (do not `sudo rm` the file).
4. Expected on first start:
   - `lockout.json` is rewritten with `schemaVersion: 2`, `failCount: 0`, `lockedUntil: 0`.
   - Security log has one `lockout_cleared` event, `method=upgrade_migration`, `previousFailCount=18`, and a verifying HMAC chain (`integrityOk: true`).
   - If email alerts are configured, one lockout-cleared mail is sent (method, time, previous fail count, source). If they are not, the event and traces report that no recipient is configured. No secrets in the mail or log.
   - `GET /api/lockout` is `"locked": false`.
   - A correct password signs in from any allowed client. A later start must **not** write a second migration event.
5. Retest local-seat recovery on the throwaway instance (PIN locked out, then password from `http://127.0.0.1` clears it; a request that adds `X-Forwarded-For` or a Bearer token does not; a client on a LAN/VPN address does not; the PIN pad still cannot bypass). Confirm the login page shows “A local password sign-in from this computer will clear the lockout.” only when `/api/auth/status` reports `localSeatRecovery: true`.
6. Retest HB-R7b-01: lock the App PIN, trigger a gated UI request (Settings → Security → Refresh). The PIN pad must show the 423 headline and `HTTP 423 · App PIN required`.
7. `sudo homebase unlock` (as root) on a throwaway lockout prints the path and previous fail count, writes `lockout_cleared` / `cli_unlock`, and emails or reports the gap. A non-root run must fail and leave the file.
8. Call `homebase_session_output` with a real `projectId`/`sessionId` and confirm the tail is redacted (no raw `hb_mcp_`, Bearer, or `password=` values).

## Deploy notes

Ship **server and web together**. Do not deploy 1.20.2 alone after this lands if you want local-seat recovery. Self-deploy still belongs to Dan. This change does not restart or redeploy Home Base.

If a site already uses `HOMEBASE_TRUSTED_PROXIES` (or a local reverse proxy / tunnel), the local-seat bypass is **disabled on purpose**. Use `sudo homebase unlock` on that machine instead.

## Security trade-offs

- Local-seat recovery is a deliberate, narrow hole in the human lockout for the machine console. It is loopback-only, header-hostile, proxy-disabled, password-only, and rate-limited. Residual risk: a local process that can open TCP to `127.0.0.1` can try the password with a 5-try escalating backoff.
- When `HOMEBASE_TRUSTED_PROXIES` is set, even a true local browser behind a local proxy cannot use the bypass (the proxy would make remote traffic look local). Operators in that setup use `sudo homebase unlock`.
- Any unversioned `lockout.json` (1.19.x and also 1.20.0–1.20.2 files, which had no schema marker) is cleared on first 1.20.3 start. That is intentional so a shared bot+human lock cannot survive the upgrade.
- An expired lockout is cleared on the next status/login check (`method=expired`) and is logged / emailed the same way.
