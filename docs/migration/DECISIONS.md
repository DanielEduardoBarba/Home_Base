# Decisions (Bun-only)

## Layout

- **Choice:** Bun lives in `server/`; Next SPA in `web/` (static export → `web/dist`).
- **Rationale:** Single runtime for API/WS/View; no dual Python tree to maintain.
- **Supersedes:** Dual `server/` + `server-py/` layout and `--python` rollback.

## View capture

- **Choice:** Seat-user Bun `--view-worker` with `bun:ffi` (libX11 + XTest).
- **Rejected:** Python mss worker (removed).

## Deploy

- **Choice:** `bun build --compile` + install SPA beside the binary; systemd `homebased.service`.
- **Rejected:** Nuitka / uvicorn onefile path (removed).

## Cursor SDK

- **Choice:** In-process `@cursor/sdk` in the Bun server.
- **Rejected:** Separate cursor-sdk Node bridge install for Nuitka (removed).
