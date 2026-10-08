# Home Base

Generic mobile-first control plane for any local projects — run scripts, shells, edit files, and chat with local Cursor agents.

- **Production:** `:8888` (systemd service runs as **root**)
- **Dev:** API `:8080`, Vite UI `:3080` (proxies `/api` + `/ws` so the SPA uses the same paths as prod)

## Quick start

```bash
./build.sh --setup          # deps, UI build, JWT signing key
# Presets are templates only — always pass --path for where the repo lives
./build.sh --add-project --preset example --path /path/to/your-repo
./build.sh --run
```

Open `http://localhost:3080` in development (or `http://localhost:8888/` in production) and **create a password** (localhost only). Later sign-ins get a **24h JWT** stored in `localStorage`.

## Same-origin API

Fetch and WebSocket clients always use relative `/api/...` and `/ws/...` against `location.host`. That contract is identical in development (Vite proxy → uvicorn) and production (FastAPI serves SPA + API together). Do not hardcode ports in the frontend.

## Projects (gitignored config)

Projects are **not** baked in. Register them yourself:

```bash
./build.sh --add-project --preset example --path /path/to/your-repo
./build.sh --add-project --path /path/to/repo --id myapp --name "My App"
```

`--preset` only supplies actions/ports/`stateDir`. **`--path` is always required** — projects can live anywhere.

Config file: `config/projects.json` (**gitignored**).  
Example shape: [`config/projects.example.json`](config/projects.example.json).  
Presets (path-agnostic templates): [`config/presets/`](config/presets/) — only `example.json` is committed; add your own under that folder (gitignored).

Each action is a button → script + flags inside the project directory:

```json
{
  "id": "run",
  "label": "Run",
  "script": "./build.sh",
  "args": ["--run"],
  "kind": "run",
  "group": "main",
  "variant": "primary"
}
```

Special `type` values: `stop`, `restart` (with `restartAction`).

## Tabs

| Tab | Purpose |
|-----|---------|
| Apps | Project actions from config |
| Files | Navigator + CodeMirror editor (TS/JS/PY/…) |
| Shell | Interactive PTY |
| Cursor | Local `cursor-sdk` agent chat |
| Mon | Sessions, ports, logs |
| Alerts | Notifications + history (paginated) |

## Security

- Password (scrypt hash in `.runtime/auth.json`) → Bearer JWT (24h TTL) on all API/WS calls
- Password set/change only from a localhost-loaded UI; Share QR is a 20s one-time redeem id
- After **5** failed logins: progressive lockout `10s → 30s → 1m → 3m → 5m → 10m → 30m → 1h → 1d`
- Failures and errors append to `.runtime/logs/YYYY-MM-DD.log` and the Alerts inbox

## Env

Copy [`.env.example`](.env.example). Never commit `.env` or `config/projects.json`.

| Var | Role |
|-----|------|
| `HOMEBASE_JWT_SECRET` | Optional JWT HMAC override (else `.runtime/jwt_secret`) |
| `CURSOR_API_KEY` | Local Cursor agents |
| `HOMEBASE_HOST` / `HOMEBASE_PORT` | Bind (dev default `0.0.0.0:8080`; systemd forces `:8888`) |

## Binary + systemd

```bash
./build.sh --bin                 # Nuitka one-file → dist/homebase (gitignored)
./build.sh --service             # install homebased.service + /usr/share/homebased/homebase
./build.sh --deploy              # --bin → install binary/wrapper → enable/restart service
```

Service **`homebased`** runs as **root**, binds **port 8888**, execs wrapper `/usr/bin/homebase` → binary `/usr/share/homebased/homebase`, and uses `HOMEBASE_HOME=/var/lib/homebased` for `.env`, `config/projects.json`, and `.runtime/`.  
Unit file: [`packaging/homebased.service`](packaging/homebased.service).

## Dev

```bash
./build.sh --run
# Hotkeys: r=restart both · a/q=API · w=Vite · h=help · Ctrl+C=quit
# API  http://localhost:8080
# Vite http://localhost:3080  (proxies /api + /ws → :8080)
```
