# Home Base Presence (Tauri mini-app)

Lightweight native desktop window for remoted **Web GUI** humans and **MCP AI** characters + chat.
Layout: who’s here (tap to focus) → expression bubble → operator↔AI chat.

## Stack

- **Tauri 2** (native shell, always-on-top, frameless)
- **Vite + React + Tailwind CSS v4** (fast SPA — same role as the main Next static SPA, smaller for a tray window)
- Talks to Home Base via local presence token (`/api/presence/ui`)

## Setup (via Home Base)

`./build.sh --setup` installs `presence-app` JS deps and, on Linux with Rust +
webkit/dbus packages present, builds `dist/homebase-presence` automatically.

## Dev

```bash
cd presence-app
bun install
bun run tauri:dev
```

Set env (homebased does this automatically when spawning):

```bash
export HOMEBASE_PRESENCE_BASE=http://127.0.0.1:8080
export HOMEBASE_PRESENCE_TOKEN="$(cat ../.runtime/presence_ui_token)"
```

## Linux build deps (once)

```bash
sudo apt install -y libdbus-1-dev pkg-config libwebkit2gtk-4.1-dev \
  libgtk-3-dev librsvg2-dev patchelf
```

## Release binary

```bash
cd presence-app
# or from repo root:
./scripts/build-presence.sh [--install]
# → dist/homebase-presence  (and optionally /usr/share/homebased/…)
```

Optional install for systemd/root seat spawn:

```bash
sudo install -m 755 src-tauri/target/release/homebase-presence /usr/share/homebased/homebase-presence
# or
mkdir -p ~/.local/share/homebase && cp src-tauri/target/release/homebase-presence ~/.local/share/homebase/
```

Override path with `HOMEBASE_PRESENCE_BIN=/path/to/homebase-presence`.

If the binary is missing, homebased falls back to Chromium `--app`.

## MCP

Same flows as before: `homebase_presence_express`, `_chat_send`, `_chat_read`, `_status`. The Tauri UI is just a better native surface for the operator.
