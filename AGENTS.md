# Home Base — agent guide

Generic control plane. **Production `:8888`** (systemd as root). **Dev API `:8081`**, **Vite `:3081`** (proxies `/api` + `/ws`) — one off the usual defaults so `./build.sh --run` can sit beside prod. Projects are configured in **gitignored** `config/projects.json` — nothing is hardcoded until added via CLI.

**Backend default is Bun** (`server-ts/`). Python FastAPI (`server/`) remains for rollback via `--python`.

## Setup

```bash
./build.sh --setup
./build.sh --add-project --preset example --path /path/to/your-repo
./build.sh --run                 # Bun API + Vite
./build.sh --run --python        # Python uvicorn + Vite (rollback)
```

Presets never embed a default filesystem path — always pass `--path`.

Open the UI at `http://localhost:3081` in dev (Vite). Production is `http://<host>:8888/`.

## Same-origin client API

SPA fetch/WebSocket paths are always relative (`/api/...`, `/ws/...` via `location.host`). Dev and prod use the same client code — Vite proxies those paths to the API in development; the backend serves SPA + API together in production.

## UI tabs

Apps · **Work** · Chat · Shell · Files · **View** · Logs · **More/Settings**. Alerts live in the status bar (host/live).

- **Work** — switch Apps / Shell / Files in one workspace with a bottom-right chat dock (Cursor-like). Chat can present a shell or file into the scene.
- **Chat** — full-page agent; same engine as the Work dock; can jump into Work to show Apps/Shell/Files.
- **Shell** — standalone PTY + session attach. Under systemd root, Shell/Run/Expo PTYs `setpriv` to the seat user and load that user’s login+interactive env (nvm/pnpm/cargo) so they match a native laptop terminal.
- **View** — JWT-gated live laptop screen (`/ws/view`) with pointer/keyboard; X11 capture via mss in a forked helper that setuid()s to the seat owner (root systemd cannot open the user display directly). Explicit Connect/Disconnect; maximize mode; adaptive JPEG. Capture runs only while connected.
- Alerts bell in the thin top status bar opens a top→bottom near-full inbox; History is a right drawer. Chat supports English speech→text; Cursor done pings toast/sound and optional browser notifications. Theme, notification prefs, cache clear, sign-out, and localhost Share/password live under More.

## Config model

Each project entry:

- `path` — absolute repo path
- `ports[]` — `{ id, label, port, health? }`
- `actions[]` — button → `./script.sh` + `args[]`
  - `group`: `main` | `ship` | `hotkey` | custom
  - `type`: `script` (default) | `stop` | `restart` | `compose`
  - `compose`: `[actionId, …]` when `type` is `compose` (e.g. Run + Expo → two PTYs)
  - `kind`: `run` | `expo` | `ship` | `action` (PTY session kind)

Committed presets: `config/presets/example.json` and `config/presets/homebase.json`. Other presets under `config/presets/` are gitignored. Live registry: `config/projects.json` (ignored).

## Security

- Password (set/changed only on localhost) → JWT session (24h TTL) in `localStorage`
- Password stored as scrypt hash in `.runtime/auth.json`; JWT HMAC key in `.runtime/jwt_secret`
- `authEpoch` in `auth.json` is embedded in JWTs (`ae`); password rewrite bumps epoch and invalidates old sessions
- Share QR: one-time redeem id (20s) → 24h JWT (never embeds the password)
- Progressive lockout after 5 failures (10s … 1 day)
- Same-origin SPA only — no open CORS middleware
- Daily JSONL logs: `.runtime/logs/YYYY-MM-DD.log`
- Notifications capped at 2000 rows on disk; UI paginates
- In-memory Logs tab ring (`/api/trace`) capped at 300 lines — server + web console
- Stop kills PTY sessions, pidfile PIDs, **and** listeners on configured project ports
- Intended access model: VPN to laptop; do not public-port-forward
- Run/Expo PTYs inject `HOMEBASE_ADVERTISE_HOST` / `REACT_NATIVE_PACKAGER_HOSTNAME` plus `EXPO_PUBLIC_API_URL` / `NEXT_PUBLIC_API_URL` (WireGuard iface preferred) so preset apps are reachable from VPN clients, not only localhost

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
- Version: repo `VERSION` file; status bar + `/api/version`. **Always increment** on code/behavior changes (patch by default).
- Deploy also syncs `CURSOR_MODEL` / `HOMEBASE_JWT_SECRET` and installs the cursor-sdk Node bridge (omitted from Nuitka onefile)

Writable state: `/var/lib/homebased` (`HOMEBASE_HOME`). Unit **homebased** runs as **root** on **port 8888**.

## Capabilities vs non-goals

- **Supports:** local Cursor agents (Home Base context + `homebase_*` in-process tools), project actions/PTY, Files (project + absolute host with JWT), View (X11 screen + input over JWT WS), WireGuard/homebased restart
- **Does not:** Cursor IDE buffer sync, cloud agents, public internet exposure, Wayland capture (X11 / XWayland only)

## Do not

- Commit `.env`, `config/projects.json`, personal presets, or `dist/homebase`
- Use cloud Cursor agents (local only)
- Allow scripts outside the project directory
- Weaken auth/TTL or add open CORS for convenience
