# Home Base

Control your laptop from your phone — run apps, shell, files, and chat with local Cursor agents.

**License:** MIT · [DevCon1 Solutions](https://devcon1solutions.com) · daniel@devcon1solutions.com  
**Use at your own risk.** Home Base can control shell, files, and screen. Provided AS IS with no liability.  
**Legal:** [Terms of Use](docs/TERMS.md) · [Privacy Policy](docs/PRIVACY.md) — the app blocks use until you accept.

---

## Get started

1. **Need:** a Linux laptop for always-on (recommended). Mac works to try it out.
2. Install [Bun](https://bun.sh) and [Node.js](https://nodejs.org) if you don’t have them.
3. Clone this repo, then run:

```bash
./build.sh --onboarding
```

4. Open the URL it prints (`http://localhost:8080/` by default on Linux, or follow the Mac tip for `--run`).
5. Create a password → finish the short in-app setup (PIN, Cursor key, phone access).
6. Open **Homework → Chat** — the **Home Base** project is already there. Start building.
7. Add more apps with **+** in Homework → Apps (or ask Chat).

That’s it.

### Phone access (in the app)

Pick one during setup (or later in Settings):

| Choice | What you do |
|--------|-------------|
| **WireGuard** | Install on the laptop → forward one **UDP** port on your router → scan the phone QR |
| **Cloudflare Tunnel** | Install `cloudflared` → paste a tunnel token → open the HTTPS link on your phone |

Do **not** port-forward Home Base’s HTTP port to the public internet.

---

## What `--onboarding` does

1. `--setup` — install deps, JWT secret  
2. Seeds this repo as the **Home Base** project  
3. **Linux:** `--deploy` (binary + systemd; port from `HOMEBASE_PORT` in `.env`, default **8080**)  
4. **Mac:** setup only — then `./build.sh --run` for `http://localhost:3081/`

Safe to run again. It won’t wipe other projects.

### Other commands

```bash
./build.sh --setup          # deps + seed Home Base project
./build.sh --run            # dev API :8081 + Next :3081
./build.sh --deploy         # Linux production only
./build.sh --add-project --preset example --path /path/to/repo
./build.sh --clean          # wipe caches (.env + projects kept)
```

---

## After login

| Area | Purpose |
|------|---------|
| **Home** | Dashboard |
| **Home Agent** | Simple project chat |
| **Homework** | Full control plane (Apps, Work, Chat, Shell, Files, View, Logs) |
| **Settings** | Theme, PIN, Cursor key, WireGuard, Cloudflare, reset / erase, About |
| **Home Access** | House widgets (buttons / toggles / sliders / gauges) |


---

## Projects

- First install registers **this repo** as project `homebase`.
- Add more with **+** in Apps, Chat tools (`homebase_project_upsert`), or:

```bash
./build.sh --add-project --preset example --path /path/to/your-repo
```

Registry: `config/projects.json` (gitignored). Presets live in `config/presets/`.

---

## Auth & security

- Terms of Use + Privacy Policy must be accepted (install-level) before bootstrap / continued use
- Password (localhost only to set/change) → JWT (24h)
- Optional App PIN (server-side lock)
- Cursor API key stored **encrypted** in `.runtime/` (set in the app)
- Share QR: one-time redeem (20s) → JWT — never embeds the password
- Same-origin API only (`/api`, `/ws`)

---

## Production layout (Linux)

- Unit: `homebased.service` → `/usr/bin/homebase`
- Port: `HOMEBASE_PORT` in `/var/lib/homebased/.env` (default **8080** — change it and redeploy)
- State: `/var/lib/homebased`
- Prefer VPN or Cloudflare Tunnel — not public HTTP

```bash
sudo systemctl status|restart homebased
```

---

## Env

`--setup` / `--onboarding` create `.env` when missing (no Cursor key). On Linux it also sets `HOMEBASE_DISPLAY` / `HOMEBASE_XAUTHORITY` for View. Cursor key is set in the app.

| Var | Role |
|-----|------|
| `HOMEBASE_PORT` | Production listen port (default `8080`; honored on deploy) |
| `HOMEBASE_HOST` | Bind address |
| `HOMEBASE_JWT_SECRET` | Optional JWT HMAC override |
| `CURSOR_MODEL` | Default model |
| `CURSOR_API_KEY` | Optional override (prefer in-app vault) |
| `HOMEBASE_DISPLAY` / `HOMEBASE_XAUTHORITY` | Linux View (X11) only |

---

## Troubleshooting

| Symptom | Try |
|---------|-----|
| Can’t reach from phone | VPN up? Tunnel running? Prefer WireGuard IP or Cloudflare HTTPS URL |
| Chat says key missing | Settings → Cursor API key |
| Session expired | Sign in again (24h TTL or password changed) |
| Deploy on Mac fails | Expected — use `./build.sh --run` on Mac; deploy on Linux |

---

## Tests

```bash
cd server && bun run typecheck && bun test
HOMEBASE_SELF_TEST=1 bun run server/src/entry.ts
cd web && npm run typecheck && npm run build
```

---

## Known limits

- Production / WireGuard host / View (X11) are **Linux-first**
- Wayland-native capture not supported
- Intended access: VPN or Cloudflare — not open internet without a password

Full agent notes: [AGENTS.md](AGENTS.md)
