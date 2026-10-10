# Review queue

## R-001: Production packaging shape for Bun

- **Issue:** Exact prod artifact (bun compile vs bun runtime + entry) and wrapper self-test
- **Why deferred:** Consequential for `/usr/share/homebased` layout
- **Affected:** T-WIRE deploy
- **Recommended:** `bun build --compile` → `dist/homebase` mirroring Nuitka layout; keep `.bak` rollback
- **Safe work:** Dev `--run` Bun path; deploy wiring toward compile when ready

## R-002: View X11 worker without Python

- **Issue:** mss/Pillow/XTest in Python view-worker
- **Why deferred:** Native X11 capture unverified overnight
- **Affected:** T-VIEW, cutover honesty
- **Recommended:** Bun FFI or native helper; temporary Python worker = incomplete

## R-003: IDE hook failClosed UX

- **Issue:** Cursor IDE agents blocked 560s when Chat UI not approving
- **Why consequential:** Changes security UX for agent tool gating
- **Recommended:** Shorter timeout, fail-open when no listeners, or separate IDE vs in-app agent hooks
- **Safe work:** Documented emergency clear of hooks.json; Bun `requestApproval` fail-open when ask + no UI

## R-004: node-pty incompatible with Bun 1.3.11

- **Issue:** Loading `node-pty` native addon panics (`uv_version_string` unsupported)
- **Evidence:** bun test / entry crash with pty.node
- **Affected:** T-PTY full TTY parity (resize, job control)
- **Current:** Pipe-backed shell fallback in `server-ts/src/pty.ts` (incomplete vs Python ptyprocess)
- **Recommended:** Bun-native PTY, `bun-pty`, or Node child for PTY only
