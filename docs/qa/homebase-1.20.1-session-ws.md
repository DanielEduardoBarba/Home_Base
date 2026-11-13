# Home Base 1.20.1 — Session cookies and WebSocket tickets

Developer note (not a QA pass). Build is on `development_grok`. **Not deployed.** Live host is unchanged until Dan self-deploys.

This release closes the two gaps called out in 1.20.0: the web UI session JWT in `localStorage` (XSS can steal it) and the long-lived JWT in the WebSocket URL (it can leak via logs, history, and Referer).

## What changed

- **Session cookie** `hb_session`: HttpOnly, SameSite=Strict, Path=/. The JWT is no longer readable by JavaScript.
- **CSRF** `hb_csrf` (not HttpOnly) plus `X-CSRF-Token` on POST/PUT/PATCH/DELETE when the request uses the session cookie. `GET /api/auth/session` returns `{ authenticated, expiresAt, csrfToken }` so a reload can restore CSRF without exposing the JWT.
- **Secure flag:** set only when the connection is HTTPS (direct, or `X-Forwarded-Proto: https` from a trusted proxy). See deploy notes below.
- **Migration:** on first load after upgrade the SPA clears `homebase_jwt`, `homebase_jwt_exp`, and legacy `homebase_token` from localStorage and shows password/PIN login once. Cookie sessions after that persist across reloads (until expiry or sign-out). `POST /api/logout` clears the cookies.
- **Login JSON** still includes `token` so a CLI or presence-style Bearer client can keep using it. The web UI ignores that field and must not store it.
- **WebSocket tickets:** `POST /api/ws-ticket` (cookie + CSRF, or Bearer) returns a ≤30 second, single-use ticket bound to the session (auth epoch + jti). The browser connects with `?ticket=`. Reuse and expiry fail. Tickets are stored as SHA-256 hashes and must never be written to logs. `?token=` JWTs are rejected. `Authorization: Bearer` on the upgrade still works for non-browser clients.

MCP connectors, `/mcp`, `/mcp/token`, and the presence app Bearer path are unchanged.

## Deploy notes (HTTP vs HTTPS)

Dan typically reaches Home Base over **plain HTTP** on localhost or a WireGuard IP (for example `http://10.6.0.1:8080`). In that mode the session cookie **cannot** be marked `Secure`; browsers will not store a Secure cookie on an `http://` page. That is expected and documented. Only use HTTP on a trusted network (this machine, LAN, or the VPN).

If Home Base is later served over **HTTPS** (Cloudflare Tunnel, Caddy, or similar):

1. Put the TLS terminator’s socket address in `HOMEBASE_TRUSTED_PROXIES` so `X-Forwarded-Proto: https` is believed.
2. The session and CSRF cookies will then be marked `Secure`.

SameSite=Strict means a click from Slack or email onto the Home Base URL will not send the session cookie on that first navigation. A bookmark, typed URL, or a same-tab refresh will. Sign-in again if that happens.

After deploy, every existing browser session must sign in once (password or PIN). MCP and presence Bearer tokens are not affected and do not need to be reminted for this change.

Do not deploy 1.20.0 alone; this 1.20.1 build is the one that should go out.

## QA checklist

- After upgrade, an old `localStorage` JWT is gone and the login page is shown once.
- Login over HTTP (localhost or VPN IP): cookies set; `hb_session` is HttpOnly + SameSite=Strict and **not** Secure; PIN/shell/chat keep working; reload stays signed in.
- State-changing request without `X-CSRF-Token` (or with a bad one) returns 403 `csrf` and does not drop the session.
- Sign-out clears cookies; the next load is the login page.
- Terminal / View / Chat WebSockets connect (ticket in the URL, not a JWT). A reused or stale ticket does not stay connected.
- curl/CLI/MCP with `Authorization: Bearer` still works and does not need a CSRF header.
- If HTTPS is in front: confirm `Secure` on both cookies.
