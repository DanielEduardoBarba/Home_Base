# Home Visitor (Tauri mini-app)

Lightweight native desktop window for remoted **Web GUI** humans and **MCP AI** characters + chat.
Layout: who’s here (tap to focus) → expression bubble → operator↔AI chat.

Binary name: **`homevisitor`**. Spawned as a child of `homebased` (no separate systemd unit).

## Stack

- **Tauri 2** (native shell, frameless; normal stacking — not always-on-top)
- **Vite + React + Tailwind CSS v4**
- Talks to Home Base via local presence token (`/api/presence/ui` — protocol id unchanged)

## Setup (via Home Base)

`./build.sh --setup` installs `homevisitor` JS deps and, on Linux with Rust +
webkit/dbus packages present, builds `dist/homevisitor` automatically.

## Dev

```bash
cd homevisitor
bun install
bun run tauri:dev
```

Set env (homebased does this automatically when spawning):

```bash
export HOMEBASE_VISITOR_BASE=http://127.0.0.1:8080
export HOMEBASE_VISITOR_TOKEN="$(cat ../.runtime/presence_ui_token)"
# Legacy aliases still work: HOMEBASE_PRESENCE_BASE / HOMEBASE_PRESENCE_TOKEN
```

## Linux build deps (once)

```bash
sudo apt install -y libdbus-1-dev pkg-config libwebkit2gtk-4.1-dev \
  libgtk-3-dev librsvg2-dev patchelf
```

## Release binary

```bash
./scripts/build-homevisitor.sh
# optional: ./scripts/build-homevisitor.sh --install
```

Output: `dist/homevisitor` (also `/usr/share/homebased/homevisitor` on install).

## Activity mood

Without an explicit `homebase_presence_express` mood, actors with activity in the last **20 seconds** display as **active** (not idle).
