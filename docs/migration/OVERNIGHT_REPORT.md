# Overnight / cutover report

## Outcome

Python FastAPI (`server-py/`), Nuitka (`homebase_entry.py`), and the root `tests/` pytest suite have been **removed**. Home Base is **Bun TypeScript server + Next.js static client** only.

## Architecture

| Layer | Path | Runtime |
|-------|------|---------|
| API / WS / View worker | `server/` | Bun |
| SPA | `web/` (App Router, `output: 'export'`) | Next → `web/dist` + `.br`/`.gz` |
| Prod binary | `bun build --compile` | `/usr/share/homebased/homebase` |

## Operator runbook

| Action | Command |
|--------|---------|
| Dev | `./build.sh --run` |
| Tests | `cd server && bun test` · `cd web && npm run build` |
| Deploy | `./build.sh --deploy` |

VPN clients should open `http://<wireguard-host-ip>:8888/` (see More → Services).
