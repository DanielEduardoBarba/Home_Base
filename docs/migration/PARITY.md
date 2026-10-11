# API parity

The Bun server in `server/` is the sole implementation. Former Python column references are obsolete.

Parity checklist (smoke):

- [x] `/api/health`, `/api/version`
- [x] Auth bootstrap / login / JWT / share redeem
- [x] Projects / actions / sessions / PTY WS
- [x] Files (project + absolute)
- [x] Notifications + trace
- [x] View WS + status
- [x] Cursor WS + tools
- [x] System status / restarts
- [x] Static SPA with Accept-Encoding br/gzip

Verify with `cd server && bun test` and a manual VPN session after deploy.
