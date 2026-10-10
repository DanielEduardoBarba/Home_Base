# Review queue

## R-001: Production packaging shape for Bun

- **Issue:** Exact prod artifact (bun compile vs bun runtime + entry) and wrapper self-test
- **Why deferred:** Consequential for `/usr/share/homebased` layout
- **Affected:** T-WIRE deploy
- **Recommended:** `bun build --compile` → `dist/homebase` mirroring Nuitka layout; keep `.bak` rollback
- **Safe work:** Dev `--run` Bun path; deploy wiring toward compile when ready

## R-002: View X11 worker without Python

- **Issue:** Capture/input previously required Python `homebase --view-worker` (mss + XTest)
- **Resolution:** Bun seat-user `--view-worker` (`server/src/view_worker.ts` + `view_x11.ts`) via `bun:ffi` (libX11/libXtst/libXinerama) + `jpeg-js`
- **Evidence:** Live ping/grab on `:0` returns HBVF JPEG; unit helpers covered
- **Status:** Closed for Bun path; Python mss worker retained for `--python` rollback only

## R-003: IDE hook failClosed UX

- **Issue:** Cursor IDE agents blocked 560s when Chat UI not approving
- **Why consequential:** Changes security UX for agent tool gating
- **Recommended:** Shorter timeout, fail-open when no listeners, or separate IDE vs in-app agent hooks
- **Safe work:** Documented emergency clear of hooks.json; Bun `requestApproval` fail-open when ask + no UI

## R-004: node-pty incompatible with Bun 1.3.11

- **Issue:** Loading `node-pty` native addon panics (`uv_version_string` unsupported)
- **Resolution:** **`Bun.Terminal` / `Bun.spawn({ terminal })`** with pipe fallback
- **Evidence:** `bun test` PTY unit passes when openpty available; sandbox may still get pipe fallback
- **Status:** Closed for migration path; keep node-pty out of Bun runtime
