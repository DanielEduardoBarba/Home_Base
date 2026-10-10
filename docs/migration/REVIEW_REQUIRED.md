# Review queue

## R-001: Production packaging shape for Bun

- **Issue:** Exact prod artifact (bun compile vs bun runtime + entry) and wrapper self-test
- **Why deferred:** Consequential for `/usr/share/homebased` layout
- **Affected:** T-WIRE deploy
- **Recommended:** `bun build --compile` → `dist/homebase` mirroring Nuitka layout; keep `.bak` rollback
- **Safe work:** Dev `--run` Bun path; deploy wiring toward compile when ready

## R-002: View X11 worker without Python

- **Issue:** Capture/input still run in Python `homebase --view-worker` (mss + XTest)
- **Progress:** Bun ViewHub drives that worker over JSON IPC (`HOMEBASE_VIEW_JSON=1`); View works on Bun API
- **Remaining for zero-Python:** Bun FFI / native helper for grab + XTest
- **Affected:** Full cutover claim (no Python in prod path)
- **Recommended:** Port grab/input to Bun when stable; keep JSON bridge until then

## R-003: IDE hook failClosed UX

- **Issue:** Cursor IDE agents blocked 560s when Chat UI not approving
- **Why consequential:** Changes security UX for agent tool gating
- **Recommended:** Shorter timeout, fail-open when no listeners, or separate IDE vs in-app agent hooks
- **Safe work:** Documented emergency clear of hooks.json; Bun `requestApproval` fail-open when ask + no UI

## R-004: node-pty incompatible with Bun 1.3.11

- **Issue:** Loading `node-pty` native addon panics (`uv_version_string` unsupported)
- **Resolution (in progress):** Use **`Bun.Terminal` / `Bun.spawn({ terminal })`** with pipe fallback
- **Evidence:** Outside sandbox, `Bun.spawn(..., { terminal })` returns `/dev/pts/N`
- **Note:** Sandbox/openpty may fail (`Failed to open PTY`) — fallback to pipes
