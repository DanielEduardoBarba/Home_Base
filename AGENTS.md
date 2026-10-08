# Home Base — agent guide

Generic control plane. **Production `:8888`** (systemd as root). **Dev API `:8080`**, **Vite `:3080`** (proxies `/api` + `/ws`). Projects are configured in **gitignored** `config/projects.json` — nothing is hardcoded until added via CLI.

## Setup

```bash
./build.sh --setup
./build.sh --add-project --preset example --path /path/to/your-repo
./build.sh --run
```

Presets never embed a default filesystem path — always pass `--path`.

Open the UI at `http://localhost:3080` in dev (Vite). Production is `http://<host>:8888/`.

## Same-origin client API

SPA fetch/WebSocket paths are always relative (`/api/...`, `/ws/...` via `location.host`). Dev and prod use the same client code — Vite proxies those paths to uvicorn in development; FastAPI serves SPA + API together in production.

## UI tabs

Apps · **Work** · Chat · Shell · Files · Alerts · Logs · **More/Settings**.

- **Work** — switch Apps / Shell / Files in one workspace with a bottom-right chat dock (Cursor-like). Chat can present a shell or file into the scene.
- **Chat** — full-page agent; same engine as the Work dock; can jump into Work to show Apps/Shell/Files.
- **Shell** — standalone PTY + session attach (unchanged).
- Alerts opens a bell inbox (toasts + dropdown); History is a right drawer. Chat supports English speech→text; Cursor done pings toast/sound and optional browser notifications. Theme, notification prefs, cache clear, sign-out, and localhost Share/password live under More.

## Config model

Each project entry:

- `path` — absolute repo path
- `ports[]` — `{ id, label, port, health? }`
- `actions[]` — button → `./script.sh` + `args[]`
  - `group`: `main` | `ship` | `hotkey` | custom
  - `type`: `script` (default) | `stop` | `restart` | `compose`
  - `compose`: `[actionId, …]` when `type` is `compose` (e.g. Run + Expo → two PTYs)
  - `kind`: `run` | `expo` | `ship` | `action` (PTY session kind)

Committed preset: `config/presets/example.json`. Personal presets under `config/presets/` are gitignored. Live registry: `config/projects.json` (ignored).

## Security

- Password (set/changed only on localhost) → JWT session (24h TTL) in `localStorage`
- Password stored as scrypt hash in `.runtime/auth.json`; JWT HMAC key in `.runtime/jwt_secret`
- Share QR: one-time redeem id (20s) → 24h JWT (never embeds the password)
- Progressive lockout after 5 failures (10s … 1 day)
- Daily JSONL logs: `.runtime/logs/YYYY-MM-DD.log`
- Notifications capped at 2000 rows on disk; UI paginates
- In-memory Logs tab ring (`/api/trace`) capped at 300 lines — server + web console
- Stop kills PTY sessions, pidfile PIDs, **and** listeners on configured project ports

## Files API

- Absolute paths (`/…`) may browse the host filesystem from Linux `/` (JWT required).
- Empty / relative paths stay scoped under the project root (Cursor cwd picker).
- Skip `node_modules`, `.git`, etc. unless `?all=1`.

## Deploy

```bash
./build.sh --deploy # Nuitka → dist/homebase → /usr/share/homebased + wrapper + systemd
```

- Active binary: `/usr/share/homebased/homebase` (previous known-good → `homebase.bak`)
- Wrapper `/usr/bin/homebase` (unit `homebased.service`) self-tests, then exec; on failure runs `.bak` with `HOMEBASE_RUNNING_BACKUP=1`
- Deploy syncs `CURSOR_API_KEY` from repo `.env` → `/var/lib/homebased/.env` (VPN/prod uses the latter)
- Version: repo `VERSION` file; shown bottom-right in UI; also `/api/version`

Writable state: `/var/lib/homebased` (`HOMEBASE_HOME`). Unit **homebased** runs as **root** on **port 8888**.

## Do not

- Commit `.env`, `config/projects.json`, personal presets, or `dist/homebase`
- Use cloud Cursor agents (local only)
- Allow scripts outside the project directory
