# Home Base

Mobile-first control plane for projects on your laptop — run scripts, shells, edit files, and chat with **local** Cursor agents. Intended daily use is over your **VPN** (not the public internet).

| Mode | URL | Process |
|------|-----|---------|
| **Production** | `http://<laptop>:8888/` | systemd `homebased` as **root** |
| **Development** | Vite `http://localhost:3080` → API `:8080` | `./build.sh --run` |

## Prerequisites

- Python 3.11+ (venv via `--setup`)
- Node.js + npm (SPA)
- For `--bin` / `--deploy`: `gcc`/`cc`, Nuitka (installed by setup as needed), **sudo** for systemd install
- Optional: `CURSOR_API_KEY` in `.env` for Chat

## Quick start (dev)

```bash
./build.sh --setup          # venv, npm, UI build, JWT signing key, seed config
# Presets are templates only — always pass --path
./build.sh --add-project --preset example --path /path/to/your-repo
# Put CURSOR_API_KEY in .env if you want Chat
./build.sh --run
```

Open `http://localhost:3080` and **create a password** (localhost-loaded UI only). Later sign-ins get a **24h JWT** in `localStorage`.

Hotkeys while `--run`: `r` restart both · `a`/`q` API · `w` Vite · `h` help · Ctrl+C quit.

## Daily use / production (VPN)

1. Deploy once: `./build.sh --deploy` (builds Nuitka binary, installs unit, syncs env/projects).
2. Ensure WireGuard (or your VPN) can reach the laptop.
3. On phone/iPad/desktop: open `http://<laptop-vpn-ip>:8888/` (or hostname).
4. Sign in with the password (or scan Share QR from a localhost session).
5. Status bar shows host · Live/Reconnecting · active project · Cursor when configured.

Bind defaults to `0.0.0.0` so VPN clients can connect. **Do not** port-forward this service to the public internet.

Stop / restart prod: `sudo systemctl stop|restart homebased`.

## Same-origin API

Fetch and WebSocket clients always use relative `/api/...` and `/ws/...` against `location.host`. Dev (Vite proxy) and prod (FastAPI serves SPA + API) share the same client code. No open CORS — cross-origin browser API access is not supported.

## Tabs

| Tab | Purpose |
|-----|---------|
| Apps | Project actions, ports, Run/Ship/Stop |
| Work | Apps/Shell/Files scene + Chat dock |
| Chat | Full-page local Cursor agent |
| Shell | Interactive PTY + attach managed sessions |
| Files | Host/project file browser + editor (**not** Cursor’s open buffers) |
| Alerts | Notification inbox (overlay; History drawer) |
| Logs | Capped console ring (`/api/trace`) |
| More | Theme, notify prefs, Share/password (localhost), VPN/homebased restart, sign-out |

## Projects

```bash
./build.sh --add-project --preset example --path /path/to/your-repo
./build.sh --add-project --path /path/to/repo --id myapp --name "My App"
```

- Live registry: `config/projects.json` (**gitignored**; prod copy under `/var/lib/homebased`)
- Example shape: [`config/projects.example.json`](config/projects.example.json)
- Presets: [`config/presets/`](config/presets/) — committed `example.json` and `homebase.json`; other presets gitignored

Action `type` values: `script` (default), `stop`, `restart` (with `restartAction`), `compose` (`compose: [actionId, …]` — nested compose unsupported).

## What the integration supports

| Capability | How |
|------------|-----|
| Local Cursor agents | `cursor-sdk` bridge + `/ws/cursor` (needs `CURSOR_API_KEY` + bridge install on deploy) |
| Project scripts / ports | Config-driven actions; Stop kills PTYs, pidfiles, and listeners |
| Shell | JWT-gated PTY scoped to project cwd; phone Ctrl/Esc/Tab bar |
| Files | REST read/write; relative paths under project; absolute `/…` = host browse (JWT) |
| Laptop services | WireGuard / homebased restart from More (JWT) |

**Not supported:** remote desktop / screen streaming, reading Cursor IDE open-buffer state, cloud Cursor agents, public internet exposure.

## Authentication & sessions

- Password (scrypt in `.runtime/auth.json`) → HS256 JWT, **24h TTL**
- Password set/change only from a **localhost-loaded** SPA
- Changing the password bumps `authEpoch` and **invalidates** existing JWTs
- Share QR: 20s one-time redeem id → normal 24h JWT (never embeds the password)
- Lockout after 5 failures: `10s → … → 1d`
- Logout clears the browser token only (server trusts TTL / epoch until expiry)
- WebSockets authenticate via `?token=` (browsers cannot set WS Authorization headers); do not paste WS URLs into logs

## Env

Copy [`.env.example`](.env.example). Never commit `.env` or `config/projects.json`.

| Var | Role |
|-----|------|
| `HOMEBASE_JWT_SECRET` | Optional JWT HMAC override (else `.runtime/jwt_secret`) |
| `CURSOR_API_KEY` | Local Cursor agents |
| `CURSOR_MODEL` | Default model |
| `HOMEBASE_HOST` / `HOMEBASE_PORT` | Bind (dev default `0.0.0.0:8080`; systemd forces `:8888`) |

Deploy also syncs those keys into `/var/lib/homebased/.env` and installs the Cursor SDK bridge beside the binary (Nuitka omits the Node bridge).

## Binary + systemd

```bash
./build.sh --bin                 # Nuitka → dist/homebase
./build.sh --service             # install unit + binary + bridge
./build.sh --deploy              # --bin then --service
```

- Active: `/usr/share/homebased/homebase` (previous → `homebase.bak`)
- Wrapper `/usr/bin/homebase` self-tests; on failure runs `.bak` with `HOMEBASE_RUNNING_BACKUP=1`
- State: `/var/lib/homebased` (`HOMEBASE_HOME`)
- Unit: [`packaging/homebased.service`](packaging/homebased.service)

## Connection problems

| Symptom | Try |
|---------|-----|
| Unreachable in status bar | VPN up? `systemctl status homebased`? laptop awake? |
| Chat/Shell “Reconnecting” | Wait for backoff, or tap the badge; pull-to-refresh hard reload if stuck |
| Session expired / Sign in | Password changed, or 24h TTL ended — sign in again |
| Chat: Cursor key missing | Set `CURSOR_API_KEY`, redeploy or sync `/var/lib/homebased/.env`, ensure bridge installed |
| Share link fails | Redeem within 20s; reveal again from localhost More → Share |

## Known limitations

- Production runs as **root** on `:8888` — a stolen JWT can use shell, host Files, and systemctl helpers
- Absolute Files paths intentionally allow host-wide browse when authenticated
- No remote desktop
- Client-only logout (no server token denylist); password change invalidates via `authEpoch`
- PWA Add-to-Home-Screen icons only — **no service worker** (avoids stale “live” remote state)
- Nested `compose` actions unsupported

## Tests

```bash
.venv/bin/pytest tests/ -q
HOMEBASE_SELF_TEST=1 .venv/bin/python homebase_entry.py
cd web && npm run lint && npm run build
```
