# Home Base — agent guide

Generic control plane. **Production** port from `HOMEBASE_PORT` in `.env` (default **`:8080`**, systemd as root). **Dev API `:8081`**, **Next `:3081`** (proxies `/api` + `/ws`) — can sit beside prod. Projects are configured in **gitignored** `config/projects.json` — nothing is hardcoded until added via CLI.

**Backend is Bun** (`server/`). **Frontend is Next.js** static export (`web/` → `web/dist`).

## Setup

```bash
./build.sh --onboarding            # Recommended: setup + seed Home Base project + deploy (Linux)
./build.sh --setup                 # Bun + Next deps + seed this repo as homebase project
./build.sh --clean                 # Drop leftovers, .runtime, setup/build caches
./build.sh --add-project --preset example --path /path/to/your-repo
./build.sh --run                   # Dev: Bun API + Next (proxied on :3081)
```

`--onboarding` / `--setup` auto-register this checkout as the **Home Base** project so Chat works immediately. Prefer `./build.sh --onboarding` for new installs (Linux deploys; Mac falls back to setup + `--run`).

Presets never embed a default filesystem path — always pass `--path` when adding other apps. UI: Homework → Apps **+**. Agents: `homebase_list_presets` / `homebase_project_upsert` / `homebase_project_delete`.

Open the UI at the URL printed by onboarding (`:8080` prod by default, or `:3081` in dev). Cursor API key is set in-app (encrypted at rest); `.env` is created on setup when missing.

MIT · DevCon1 Solutions · https://devcon1solutions.com · daniel@devcon1solutions.com — use at your own risk.

## Same-origin client API

SPA fetch/WebSocket paths are always relative (`/api/...`, `/ws/...` via `location.host`). Dev and prod use the same client code — Next’s `scripts/dev.mjs` proxies those paths to the API in development; the Bun backend serves SPA + API together in production.

## UI areas (after login)

**Home** dashboard → **Home Agent** · **Homework** (Work) · **Home Access** · **Vision** · **Settings**.

### Homework tabs

Apps · **Work** · Chat · Shell · Files · **View** · Logs. **Settings** is its own Home dashboard card (not in the Work dock). Alerts live in the status bar (host/live). Status bar **Home** returns to the dashboard.

- **Work** — switch Apps / Shell / Files in one workspace with a bottom-right chat dock (Cursor-like). File/shell present is click-to-open only (no auto-jump while the agent runs).
- **Chat** — full-page agent; same engine as the Work dock; can jump into Work to show Apps/Shell/Files.
- **Shell** — standalone PTY + session attach. Under systemd root, Shell/Run/Expo PTYs `setpriv` to the seat user and load that user’s login+interactive env (nvm/pnpm/cargo) so they match a native laptop terminal.
- **View** — JWT-gated live laptop screen (`/ws/view`) with pointer/keyboard; Bun seat-user `--view-worker` (libX11 `XGetImage` + XTest via `bun:ffi`). Root systemd uses setpriv/runuser to the seat owner (cannot open the user display as root). Explicit Connect/Disconnect; maximize mode; adaptive JPEG. Capture runs only while connected.
- Alerts bell in the thin top status bar opens a top→bottom near-full inbox; History is a right drawer. Chat supports English speech→text; Cursor done pings toast/sound and optional browser notifications. Home → **Settings** is a hub of grouped rows that drill into focused sub-scenes (Appearance, PIN, Sudo vault, Cursor key, WireGuard / Cloudflare, Storage, About/legal, etc.).

### Home Agent

Minimal Work+Chat: pick project → folder (app / recent / browse) → chat list → full-screen agent. Same Cursor engine as Homework Chat. Present→shell/files is a bare scene with only ← Chat. Mic **talk mode** dictates + green Confirm send + speaks replies (TTS) while armed.

### Home Access

Panel of **button / toggle / slider / gauge** widgets backed by `/api/home-access*` and `homebase_access_*` tools. Hooks: `script` · `http` · `websocket` · `static`. State in `.runtime/home_access.json`. Floating Chat dock helps wire IoT/scripts. Prefer adding widgets over rewriting the framework (see `.cursor/rules/home-access.mdc`).

### Vision

Live laptop screen (same `/ws/view` X11 worker) plus a Chat dock. **Arm** (JWT, default 15m) unlocks AI mouse/keyboard via `homebase_vision_*` tools; disarmed is look-only (screenshot/status). Linux X11 / XWayland only — not on Mac. Chat cwd is seat-user `~/.homebase` (created on demand). Prefer GUI apps via Vision; use Shell/Files/CLI when that is clearly better. Screenshots under `.runtime/vision/`. See `.cursor/rules/vision.mdc`.

### Chat persistence

Chat tabs/messages persist under `.runtime/chats/<projectId>.json` (survives `--deploy`). Saves run at send, debounced during streaming, on run end, and on SIGTERM/SIGINT. Only user tab-delete clears a chat.

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

- Terms of Use + Privacy Policy (`docs/TERMS.md`, `docs/PRIVACY.md`, in-app) — install-level accept in `.runtime/legal.json`; UI blocks Login/app until current `LEGAL_DOC_VERSION` is accepted; bootstrap refuses without it
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
- Run/Expo PTYs inject `HOMEBASE_ADVERTISE_HOST` / `REACT_NATIVE_PACKAGER_HOSTNAME` plus `EXPO_PUBLIC_API_URL` / `NEXT_PUBLIC_API_URL` (native LAN / `192.168.x` preferred over WireGuard `10.x`) so Expo Go on Wi‑Fi hits the laptop; set `HOMEBASE_ADVERTISE_HOST` to force VPN if needed

## Files API

- Absolute paths (`/…`) may browse the host filesystem from Linux `/` (JWT required).
- Empty / relative paths stay scoped under the project root (Cursor cwd picker).
- Skip `node_modules`, `.git`, etc. unless `?all=1`.

## Deploy

```bash
./build.sh --deploy # Bun compile → dist/homebase → /usr/share/homebased + wrapper + systemd
```

- Active binary: `/usr/share/homebased/homebase` (previous known-good → `homebase.bak`)
- Wrapper `/usr/bin/homebase` (unit `homebased.service`) self-tests, then exec; on failure runs `.bak` with `HOMEBASE_RUNNING_BACKUP=1`
- Deploy syncs `CURSOR_API_KEY` from repo `.env` → `/var/lib/homebased/.env` (VPN/prod uses the latter)
- Version: repo `VERSION` file; status bar + `/api/version`. **Always increment** on code/behavior changes (patch by default).
- Deploy also syncs `CURSOR_MODEL` / `HOMEBASE_JWT_SECRET`. Cursor chat uses in-process `@cursor/sdk` (no separate Node bridge).

Writable state: `/var/lib/homebased` (`HOMEBASE_HOME`). Unit **homebased** runs as **root**; listen port from `HOMEBASE_PORT` in `.env` (default **8080**).

## Capabilities vs non-goals

- **Supports:** local Cursor agents (Home Base context + `homebase_*` in-process tools), project actions/PTY, Files (project + absolute host with JWT), View (X11 screen + input over JWT WS), Vision (Armed AI desktop control via `homebase_vision_*`), WireGuard setup/manage (QR onboarding) + homebased restart, Home Access widgets (`homebase_access_*`), durable chat under `.runtime/chats/`
- **Self-deploy / restart:** `./build.sh --deploy` from a Chat/Shell PTY under homebased schedules a detached systemd oneshot (not killed by `KillMode=control-group`). API `POST /api/system/restart/homebased` and tool `homebase_restart_homebased` use `systemd-run --on-active=1s` the same way.
- **Does not:** Cursor IDE buffer sync, cloud agents, public internet exposure, Wayland capture (X11 / XWayland only)

## Do not

- Commit `.env`, `config/projects.json`, personal presets, or `dist/homebase`
- Use cloud Cursor agents (local only)
- Allow scripts outside the project directory
- Weaken auth/TTL or add open CORS for convenience
