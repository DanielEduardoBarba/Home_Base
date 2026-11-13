# Home Base 1.20.2 — QA R7 fixes

Developer note (not a QA pass). Build is on `development_grok`. **Not deployed.** Live host is unchanged until Dan self-deploys. Fixes the bugs filed in `docs/qa/homebase-r7-1.20.1.md`.

## What changed

### HB-R7-01 — Hash-chained security log actually detects tampering (High)

`querySecurityLog` only checked that `mac` and `prev` existed and that the line was JSON. It now walks every daily file in order and verifies each entry's HMAC over its canonical content (the event fields plus `prev`, the same payload used when signing) and that `prev` matches the previous entry's mac (`genesis` for the first).

- API and Security page: `integrityOk: false`, `integrityError: "tampered at line N"`, and `tamperedAt: { day, line }`.
- A mutated, deleted, or reordered line is not returned as a normal event.
- A one-shot in-app alert ("Security log tampered") fires when a new break is first seen.
- Unit tests edit a line, delete a line, and reorder lines.

### HB-R7-03 — Human logins are not labeled Known Grok Bot (Medium)

`classifySource` now decides by credential type first:

- Connector / MCP token → Known Grok Bot (when the connector or an AI presence is bound to that request).
- PIN, password, or UI cookie session → human, labeled with the device or WireGuard peer (LAN, known VPN device, or unknown/external). MCP presence or a connector last-used on the same IP is ignored for that event.

### HB-R7-02 — User agent on PIN and password events (Medium)

`/api/login` and `/api/app-pin/unlock` pass the request `User-Agent` (and path) into `recordFailure`, `recordSuccess`, and `pin_success` security events.

### Lows

- **Logout revocation:** `POST /api/logout` still expires the cookies, and also records the session JWT's `jti` (hashed) so `verifyAccessToken` rejects that token as `revoked_session` until it would have expired. A captured `hb_session` cookie or Bearer value no longer stays valid.
- **Burst alert on lockout:** the fifth human failure, recorded as `result: lockout`, still raises the "Brute-force burst" alert (threshold 5 in a 5-minute window).
- **HTTP 423:** `parseAuthError` has a distinct `pin_required` path for `423` / `pin_locked` ("App PIN required. Unlock with your PIN to continue." plus `HTTP 423 · …`). It does not look like a wrong PIN and does not send the user to password login.

## Deploy notes

Ship **server and web together**. Do not deploy 1.20.0 or 1.20.1 alone. This 1.20.2 build is the one that should go out after QA retests R7-01, R7-02, R7-03, and the three lows.

Self-deploy still belongs to Dan. This change does not restart or redeploy Home Base.
