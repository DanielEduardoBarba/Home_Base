# Home Base — agent guide

Generic control plane. **Production `:80`** (systemd as root). **Dev API `:8080`**, **Vite `:3080`** (proxies `/api` + `/ws`). Projects are configured in **gitignored** `config/projects.json` — nothing is hardcoded until added via CLI.

## Setup

```bash
./build.sh --setup
./build.sh --add-project --preset example --path /path/to/your-repo
./build.sh --run
```

Presets never embed a default filesystem path — always pass `--path`.

Open the UI at `http://localhost:3080` in dev (Vite). Production is `http://<host>/` on port 80.

## Same-origin client API

SPA fetch/WebSocket paths are always relative (`/api/...`, `/ws/...` via `location.host`). Dev and prod use the same client code — Vite proxies those paths to uvicorn in development; FastAPI serves SPA + API together in production.

## Config model

Each project entry:

- `path` — absolute repo path
- `ports[]` — `{ id, label, port, health? }`
- `actions[]` — button → `./script.sh` + `args[]`
  - `group`: `main` | `ship` | `hotkey` | custom
  - `type`: `script` (default) | `stop` | `restart`
  - `kind`: `run` | `expo` | `ship` | `action` (PTY session kind)

Committed preset: `config/presets/example.json`. Personal presets under `config/presets/` are gitignored. Live registry: `config/projects.json` (ignored).

## Security

- `HOMEBASE_TOKEN` required; SPA stores it in `localStorage`
- Progressive lockout after 5 failures (10s … 1 day)
- Daily JSONL logs: `.runtime/logs/YYYY-MM-DD.log`
- Notifications capped at 2000 rows on disk; UI paginates

## Files API

Paths are resolved under the project root only. Skip `node_modules`, `.git`, etc.

## Deploy

```bash
./build.sh --deploy # Nuitka onefile → /usr/bin/homebase + homebase.service
```

Writable state for the service: `/var/lib/homebase` (`HOMEBASE_HOME`). Binary build artifacts under `dist/` are gitignored. Unit runs as **root** on **port 80**.

## Do not

- Commit `.env`, `config/projects.json`, personal presets, or `dist/homebase`
- Use cloud Cursor agents (local only)
- Allow scripts outside the project directory
