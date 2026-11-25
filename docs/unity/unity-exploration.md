# Unity on Home Base — Exploration Report (Step 1)

Date: 2026-11-24 (America/New_York) · Host: seat Linux · Branch: `development_grok`  
Scope: read-only investigation. No installs, license changes, deletes, or Home Base redeploy.

---

## 1. Unity Hub

| Item | Value |
|------|--------|
| Package | `unityhub` **3.22.2** (amd64, deb) |
| Binary | `/usr/bin/unityhub` → `/usr/lib/unityhub/unityhub` (bash launcher → `unityhub-bin`) |
| Hub self-report | `~/.config/unityhub/hubInfo.json` → `version: "3.22.2"`, `executablePath: "/usr/bin/unityhub"` |
| Desktop | GUI via `Exec=unityhub %U` (`/usr/share/applications/unityhub.desktop`) |
| Install root for editors | `/home/daniel/Unity/Hub/Editor/` |

### How it runs

- **GUI / AppImage?** Deb-installed Electron app (not AppImage). Chromium/Ozone; needs an X display.
- **Headless CLI** form (documented / attempted):  
  `unityhub -- --headless <command>`

### CLI commands (list/install editors & modules)

Intended Hub headless surface (do **not** run install in later steps without human approval):

```text
unityhub -- --headless help
unityhub -- --headless editors -i          # list installed editors
unityhub -- --headless install <version> …
unityhub -- --headless install-modules …
unityhub -- --headless help install
unityhub -- --headless help install-modules
```

### What worked / failed (this host)

| Command | Result |
|---------|--------|
| `unityhub --version` / bare `-- --headless help` with **no DISPLAY** | **FAIL** — `Missing X server or $DISPLAY` / Ozone X11 init, process exits |
| `xvfb-run -a unityhub -- --headless …` | **HANG** — launched but produced no useful CLI output within 60–90s (killed) |
| `DISPLAY=:99 unityhub -- --headless editors -i` (Xvfb already up) | **HANG / timeout** (15s+) — no usable list |

**Practical recommendation:** treat Hub GUI as human-facing; use the official **Unity CLI** (`~/.local/bin/unity`, v1.0.1) for automation of editors/modules/license status (see §2–§3). Prefer wrapping Hub with a dedicated DISPLAY only if Hub headless is required later.

---

## 2. Unity Editor(s)

### Installed

| Version | Path | Notes |
|---------|------|--------|
| **6000.6.4f1** (Unity 6.6, changeset `12bfff696524`) | `/home/daniel/Unity/Hub/Editor/6000.6.4f1/Editor/Unity` | Only installed editor on disk. Product metadata: `Unity 6.6`, arch `x86_64`. Desktop entry points here. |

`unity editors -i --json` (CLI) reports the same single install at that location.  
`unity editors --json` also lists **available** (not installed) catalog entries such as `6000.6.10f1`, `6000.3.29f1`, etc.

### Modules

**Authoritative on disk** (`…/Editor/Data/PlaybackEngines/`):

- `WebGLSupport` — present (Web Build Support)
- `LinuxStandaloneSupport` — present (Linux player / IL2CPP tooling on disk)

**CLI** `unity install-modules -l --editor-version 6000.6.4f1 --json` (`isInstalled`):

| Module id | isInstalled | Notes |
|-----------|-------------|--------|
| `webgl` | **true** | Matches WebGLSupport on disk |
| `documentation` | **true** | |
| `linux-il2cpp` / `linux-server` | **false** (status Available) | **Conflict:** `LinuxStandaloneSupport` folder + DLLs exist; treat as present-on-disk / CLI-under-reported until a dry-run reconcile |
| android / ios / mac / windows / visionos / languages | false | Not installed |

`unity editors -i` only lists moduleNames: `["Web"]` — incomplete vs filesystem.

**Do not install modules in step 1.** For WebGL live view, `webgl` is already enough.

### Batchmode smoke

| Command | Result |
|---------|--------|
| `Unity -batchmode -nographics -quit -logFile …` (no `-projectPath`) | **FAIL exit 1** — Editor defaulted to open `/home/daniel/APP_PROJECTS/PERSONAL/GAMES/UnityAgentPlayground`, which was **already open** (“another Unity instance is running with this project open”) |
| `Unity -batchmode -nographics -quit -createProject /tmp/unity-empty-smoke-…` | **PASS exit 0** — LicensingClient launched; **Product: Unity Personal**; “Exiting batchmode successfully” |

Conclusion: **batchmode + nographics works** on this machine when the project path is free / new.

### Live Editor process (observed)

- PID running: `Unity -projectPath …/UnityAgentPlayground -logFile /tmp/unity-xvfb.log`
- Started via helper `~/mcp-setup/start-unity-xvfb-mcp.sh` on **Xvfb `:99`** (`LIBGL_ALWAYS_SOFTWARE=1`)
- Pipeline TCP: **`127.0.0.1:7800` LISTEN** (Unity Main Thread)
- `unity status --json`: instance discovered on port 7800 but often **`state: "unreachable"`** / `STATUS_ALL_UNREACHABLE` (“verify the Pipeline package is installed”)
- `unity command scene` / `editor` **listing** succeeds (command catalog returned)
- `unity command scene list_open --timeout 30`: **TIMEOUT** (Editor busy / Pipeline handshake flaky during imports)

Project has `com.unity.pipeline` **1.0.1** in `Packages/manifest.json`.

---

## 3. Licensing (status only — no activate/return/sign-in)

| Item | Status |
|------|--------|
| Legacy `~/.local/share/unity3d/Unity/Unity_lic.ulf` | **ABSENT** |
| Entitlement file | `~/.config/unity3d/Unity/licenses/UnityEntitlementLicense.xml` present |
| Active product (Editor log + `unity license`) | **Unity Personal** (Assigned) + Asset Store entitlements |
| Serial | Not used / not present as ULF (do not hunt or print) |
| Unity Licensing Client | Auto-spawned with Editor; binary under Editor `…/Licensing/Client/` and Hub `UnityLicensingClient_V1` / `~/.config/unityhub/external-modules/licensingClient`; version **1.18.3** |
| Online refresh | Logs show **access token unavailable / 401** on Genesis update; local entitlement still resolves Personal |
| Hub accounts DB | `~/.config/unityhub/accounts.db` present (contents not inspected) |

Redacted entitlement tag: `Tag="UnityPersonal"`, `Product="Unity Personal"`, headless entitlement `com.unity.editor.headless` present. User/org ids and machine bindings omitted from this report.

**CLI that worked:** `unity license --json` → Personal + Asset Store, Assigned.

---

## 4. Unity MCP

Two stacks are configured in `~/.cursor/mcp.json` (tokens redacted):

### A) Official Unity CLI MCP (`unity` server)

```json
"unity": {
  "command": "/home/daniel/.local/bin/unity",
  "args": ["mcp", "--tool-groups", "--project-path",
           "/home/daniel/APP_PROJECTS/PERSONAL/GAMES/UnityAgentPlayground"]
}
```

- Binary: `/home/daniel/.local/bin/unity` **v1.0.1** (Unity’s own CLI; not Coplay)
- Connects via **Unity Pipeline** package to Editor on **port 7800**
- Process observed: `unity mcp --tool-groups --project-path …/UnityAgentPlayground`
- Tools: with `--tool-groups`, one MCP tool per Pipeline **command group**. Groups observed when listing against the live Editor include:  
  `animation`, `animation.animator`, `animation.clip`, `animation.timeline`, `asset`, `authoring`, `build`, `build.target`, `capture`, `component`, `console`, `diagnostics`, `editor`, `editor.playmode`, `gameobject`, `job`, `lighting`, `material`, `multiplayer`, `multiplayer.role`, `navmesh`, `occlusion`, `package`, `pipeline`, `prefab`, `runtime`, `scene`, `script`, `script.methodreload`, `settings` (+ audio/graphics/input/physics/player/quality/…), `test`, …
- Example scene commands: `scene list_open`, `scene get_hierarchy`, `scene open`, `scene save`, …
- Harmless probe: **catalog list OK**; **execute** `scene list_open` **timed out** (30s) while Editor was busy. `unity status` often unreachable even though TCP 7800 listens.

### B) CoplayDev MCP for Unity (`unity-coplay`)

```json
"unity-coplay": {
  "command": "uvx",
  "args": ["--from", "mcpforunityserver", "mcp-for-unity", "--transport", "stdio"]
}
```

| Item | Value |
|------|--------|
| Upstream | [CoplayDev/unity-mcp](https://github.com/CoplayDev/unity-mcp) (Aura/Coplay) |
| Local clone | `~/mcp-setup/clones/unity-mcp` |
| Python server | `mcpforunityserver` **10.3.0** (`mcp-for-unity`) |
| Unity package | `com.coplaydev.unity-mcp` **10.3.1-beta.11** (git `#main` → `MCPForUnity`) in UnityAgentPlayground |
| Bridge | Unity package default TCP **6400** (`PortManager`); HTTP helper default `http://127.0.0.1:8080` |
| Port 6400 | **Not listening** at probe time → bridge not up / not started |
| Port 8080 | Home Base web UI (not Coplay); `/mcp` returns Home Base MCP token error |

#### Full Coplay tool list (48 tools from Cursor MCP descriptors)

`apply_text_edits`, `batch_execute`, `blender_bridge`, `create_script`, `debug_request_context`, `delete_script`, `execute_code`, `execute_menu_item`, `find_gameobjects`, `find_in_file`, `generate_audio`, `generate_image`, `generate_model`, `get_sha`, `get_test_job`, `import_model`, `import_model_file`, `manage_animation`, `manage_asset`, `manage_build`, `manage_camera`, `manage_components`, `manage_editor`, `manage_gameobject`, `manage_graphics`, `manage_material`, `manage_packages`, `manage_physics`, `manage_prefabs`, `manage_probuilder`, `manage_profiler`, `manage_scene`, `manage_script`, `manage_script_capabilities`, `manage_scriptable_object`, `manage_shader`, `manage_texture`, `manage_tools`, `manage_ui`, `manage_vfx`, `read_console`, `refresh_unity`, `run_tests`, `script_apply_edits`, `set_active_instance`, `unity_docs`, `unity_reflect`, `validate_script`

Resources include: `mcpforunity://editor/state`, `project/info`, `unity_instances`, etc.

#### Harmless read-only call

- Attempted stdio MCP `resources/read` `mcpforunity://editor/state` and `manage_scene(action=get_active)` via `uvx … mcp-for-unity`: **no successful response** (init/read hung; consistent with **no listener on 6400**).
- Cursor descriptors for `user-unity-coplay` exist under another project’s MCP cache; this Home Base chat session does **not** expose Coplay tools natively.

**Also not present as primary:** IvanMurzak / justinpbarnett / generic `mcp-unity` as the active config — Coplay + official Unity CLI MCP are the two wired entries.

Helper script worth keeping for later steps: `~/mcp-setup/start-unity-xvfb-mcp.sh` (Xvfb `:99`, accept Software Terms in prefs, wait for `unity status`).

---

## 5. How Home Base models projects / View / Unity plug-in points

### Projects & presets

- Registry: `config/projects.json` (+ runtime reconcile).
- Presets: `config/presets/{example,homebase,stockwinter,ekklesias,clocktrakr}.json` — **no Unity preset yet**.
- MCP upsert: `homebase_project_upsert` / `upsertProjectFromInput` in `server/src/config.ts`.
- MCP workspaces root: `~/MCP_WORKSPACES` (`server/src/workspace.ts` → `mcpWorkspacesRoot()`; override `HOMEBASE_MCP_WORKSPACES_ROOT`).
- Create: `homebase_create_mcp_workspace` → `createMcpWorkspace(name)` (Settings toggle required). Creates folder, marker `.homebase-mcp-workspace`, registers project (typically **example** Run/Ship port triplet via `mcpWorkspaceUpsertFields`).
- Existing workspaces observed: `App_Eco_Template`, `Couples_Daily`, `DoodlePie`, `Markour_Board_audit`, `Okeroo`, `rules`, …
- Onboarding: `server/src/onboarding_state.ts` + `/api/onboarding` — first-run wizard (password / remote WireGuard|Cloudflare). **Not** Hub/Editor/module doctor yet.

### View side

- UI: `web/src/components/ViewTab.tsx` — phone browser remote desktop: JPEG frames over WS, touch/mouse, quality ladder.
- Capture: `server/src/view.ts` + `view_worker.ts` — **seat X11** via libX11 (`DISPLAY` / `HOMEBASE_DISPLAY`, Xauthority heuristics, Wayland/Xwayland cookie preference).
- Seat sockets present: `/tmp/.X11-unix/X0`, `X1`. Unity Editor for MCP is on **Xvfb `:99`** (`X99`).

### What looks broken / mismatched for Unity

1. **View ≠ Unity display:** Home Base View streams the **seat desktop** (`:0`/`:1`), not the headless Editor on `:99`. Phone View will not show the Unity Game/Scene view unless Editor is moved to the seat display or View gains a selectable capture target (Xvfb).
2. **Dual MCP / bridge fragility:** Pipeline 7800 listens but status/commands often unreachable/timeout; Coplay 6400 not listening — agents cannot reliably drive the Editor right now.
3. **Hub headless unusable** without a working display path — automation should prefer `unity` CLI.
4. **No Unity preset / setup checks** in onboarding or project doctor — Unity would currently look like a generic folder under MCP_WORKSPACES or an external path project.
5. Port **8080** is Home Base itself — Coplay’s default HTTP URL collides if someone enables Coplay HTTP on 8080.

### Where Unity plugs in (design hooks)

| Layer | Hook |
|-------|------|
| Preset | New `config/presets/unity.json` (ports: webgl preview, optional MCP bridge; actions: open-editor-xvfb, webgl-build, serve-webgl, stop) |
| Workspace | Template under `~/MCP_WORKSPACES/<name>` or clone sample; marker + `homebase_create_mcp_workspace` / GitHub clone |
| Setup checks | Extend onboarding or project status: Hub present, Editor version, modules `webgl` (+ linux), license Personal/Pro (redacted), Pipeline/Coplay bridge ports, Xvfb |
| View | Either (a) WebGL iframe/port in project UI (recommended), or (b) teach View to capture `:99` / project-bound display |
| MCP | Prefer one stack per workspace; document Coplay package + `unity mcp` Pipeline; avoid 8080 clash |

---

## 6. Remote live view options (phone browser, headless)

Host constraints:

- **GPU:** AMD Cezanne iGPU (`/dev/dri/card1`, `renderD128`). **No NVIDIA** / no `nvidia-smi`.
- **Display:** Seat X11 `:0`/`:1`; agent Unity on **Xvfb `:99`** (installed: `xvfb` / `xvfb-run`). Shell `DISPLAY` often empty for services.
- **Software GL:** already used (`LIBGL_ALWAYS_SOFTWARE=1`) for Editor under Xvfb.
- **Node/serve:** Node v24, `npx`/`serve` available for static WebGL.

| Option | Feasibility | Notes |
|--------|-------------|--------|
| **(a) WebGL build + static/dev server + reload** | **High — recommended** | `webgl` module installed; batchmode builds work in principle; serve `Build/` on a project port; watch Assets → rebuild → browser reload. Fits Home Base ports/actions + phone over VPN. No need to stream Editor pixels. |
| **(b) Unity Render Streaming / WebRTC** | **Low–medium** | Not installed in playground. Needs packages + signaling + encoder; AMD/software path is painful; more moving parts than WebGL preview. |
| **(c) Other** | Mixed | Home Base **View** = seat desktop only (misses Xvfb Unity). **Vision** = armed seat GUI (wrong surface for headless Editor). Linux player window on seat + View = possible but heavy and not phone-first. |

### Recommendation

**Ship (a) WebGL live preview:** project action builds WebGL to a known output dir; `serve` (or Home Base static) on a reserved port; file watcher triggers rebuild; client auto-reloads. Use Coplay/Pipeline MCP for authoring; use WebGL for “see it on the phone.” Defer Render Streaming unless interactive editor-quality streaming is a hard requirement.

---

## Recommended implementation plan (Steps 2–5)

### Step 2 — Onboarding / setup checks

- Add a **Unity doctor** (API + Settings/onboarding panel): Hub package/path/version; `unity editors -i`; modules (`webgl` required, `linux-il2cpp` optional); `unity license` (Personal/Pro only, redact ids); Xvfb present; Pipeline port / Coplay 6400; warn if Editor on `:99` vs View on seat.
- Fail soft with copy-paste fix commands; never auto-activate licenses.

### Step 3 — Unity workspace template under `~/MCP_WORKSPACES`

- Preset `unity.json`: ports e.g. `webgl` (static), optional `mcp-bridge`; actions: `editor` (xvfb script), `webgl-build`, `webgl-serve`, `stop`.
- `createMcpWorkspace` / template scaffold: `.gitignore` Unity-friendly, `Packages/manifest` with Pipeline + optional Coplay package, README, `ProjectVersion.txt` pinned to **6000.6.4f1**.
- Sample workspace (step 5) seeded from a minimal 3D/URP scene.

### Step 4 — Hub / editor / module management + license display

- Prefer **`unity install` / `unity install-modules`** (with `--dry-run` first) over Hub headless.
- UI: installed editors, module badges (WebGL/Linux), license **Personal/Pro** + Licensing Client up/down (no serials/emails).
- Document that Hub GUI remains for human account tasks (Settings precedence).

### Step 5 — View fixes + WebGL live view + sample

- **View:** document limitation; optional “capture display” override (`HOMEBASE_DISPLAY=:99`) for advanced users; do not pretend seat View shows Xvfb Unity by default.
- **WebGL live view:** action pipeline — `Unity -batchmode -nographics -quit -executeMethod …BuildWebGL` → output under project `Builds/WebGL` → `serve -l <port>`; watch + rebuild; surface URL in project card / iframe.
- **Sample workspace** in MCP_WORKSPACES proving Editor open (xvfb) + MCP read + WebGL phone preview.
- Stabilize **one** MCP path (recommend Coplay for rich tools **or** official Pipeline MCP for first-party support; avoid dual confusion). Ensure bridge port is up before advertising tools.

### Non-goals / constraints (carry forward)

- Do not buy/sign-in/change licenses from agents.
- Do not collide Coplay HTTP with Home Base `:8080`.
- Do not force-push; keep Unity work on `development_grok`.
- Leave operator dirty files in the Home Base checkout untouched.

---

## Command cheat-sheet (verified)

```bash
# Editors / modules / license (official CLI)
unity --version                          # 1.0.1
unity editors -i --json
unity install-modules -l --editor-version 6000.6.4f1 --json
unity license --json

# Batchmode (use free project path)
"/home/daniel/Unity/Hub/Editor/6000.6.4f1/Editor/Unity" \
  -batchmode -nographics -quit -createProject /tmp/empty -logFile /tmp/u.log

# Pipeline (Editor must be responsive)
unity status --json
unity command scene                      # list commands
unity command scene list_open --timeout 60 --json

# Hub (needs working DISPLAY; currently unreliable headless here)
unityhub -- --headless editors -i
```

---

## Step 2 status (2026-11-24)

### A — MCP bridge (done)

| Item | Result |
|------|--------|
| Scratch project | `~/MCP_WORKSPACES/unity-sample` created via `Unity -batchmode -nographics -quit -createProject` |
| MCP package | `com.coplaydev.unity-mcp` (git `#main` → `MCPForUnity`) in `Packages/manifest.json` |
| Headless bridge | `UNITY_MCP_ALLOW_BATCH=1 Unity -batchmode -nographics -executeMethod MCPForUnity.Editor.McpCiBoot.StartStdioForCi` (no Hub GUI) |
| Scripts | `scripts/unity/start-editor-bridge.sh`, `stop-editor-bridge.sh` (repo + copied into sample) |
| Verify | TCP `:6400` listen; framed handshake `WELCOME UNITY-MCP 1 FRAMING=1`; ping → `{"status":"success","result":{"message":"pong"}}` |
| xvfb | Not required for this batchmode path; Xvfb still available for GUI Editor if needed later |

### B — Home Base onboarding / template / license UI (done)

| Item | Result |
|------|--------|
| Doctor API | `GET /api/unity/status` — Hub, editors+WebGL, license (product/type only), bridge reachability, sample project |
| Settings UI | Settings → Unity panel + Setup scene link to Unity doctor |
| System status | Lightweight `unity.hubPresent` / `unity.editorPresent` flags on `/api/system/status` |
| Preset | `config/presets/unity.json` (webgl + mcp-bridge ports; editor/webgl_build/webgl_serve/stop actions) |
| Workspace create | `createMcpWorkspace(name, { preset: "unity" })` → batchmode createProject + MCP package + script copy + unity preset registration |
| Detection | Folders with `ProjectSettings/ProjectVersion.txt` auto-get unity preset on reconcile/upsert |
| Tests | `server/test/unit/unity.test.ts` |

### C — WebGL (script only; live view deferred)

| Item | Result |
|------|--------|
| Build script | `scripts/unity/build-webgl.sh` — batchmode `-buildTarget WebGL` + `HomeBase.Editor.EditorBuildScript.BuildWebGL` (auto-seeded into project) |
| Serve | `npx --yes serve -l <webgl-port> Builds/WebGL` (preset action `webgl_serve`) |
| Live phone iframe / watch-reload | **Not implemented** (Step 5). Notes unchanged: prefer WebGL static preview over streaming Xvfb Editor |

### Human next steps

1. Deploy Home Base when ready: `./build.sh --deploy` (agent must not self-deploy).
2. Sign-in / license changes remain Hub GUI only if Personal entitlement ever expires (do not ask agents).
3. Register `unity-sample` in the project card if desired (`preset=unity`), or create new workspaces via MCP with `preset: "unity"`.
4. Only one Coplay bridge on `:6400` at a time; stop before starting another project’s bridge.

---

## Steps 3–5 status (2026-11-24)

### Detection bug fix (0d4258c follow-up)

| Item | Result |
|------|--------|
| Root cause | `homebased` runs as **root**; `system.ts` used `process.env.HOME` (`/root`) for Editor path while Hub was found via `/usr/bin/unityhub` → Hub OK, Editor “missing” |
| Fix | `server/src/unity_paths.ts` — seat home via `detectSeatUser` / `/home/*` Hub scan; always merge CLI + filesystem; resolve `unity` CLI from `~/.local/bin` + `cli-install.json`; Hub `secondaryInstallPath`; same robustness for modules/license/CLI |
| Regression | `server/test/unit/unity_paths.test.ts` fake Hub dir layout |

### Step 3 — View fixes

| Fix | Detail |
|-----|--------|
| Idle copy | View is **seat laptop screen**, not Unity/WebGL |
| Max | Enabled while connecting (not only after first frame) so phone can hide nav chrome earlier |
| Mobile stage | View column fills leftover shell height under top/bottom chrome |
| Apps port tiles | `webgl` → `webgl`/`webgl_serve` action alias; `mcp-bridge` never opens `http://:6400/` (TCP toast / start editor) |
| WebGL iframe | `WebGLPreview` on project card (~390×844) + “Open on phone” |

### Step 4 — WebGL live view

| Item | Result |
|------|--------|
| Scripts | `live-webgl.sh` (watch Assets/Packages/ProjectSettings → debounced rebuild → serve); `serve-webgl.sh` + `serve-webgl.mjs` (bind **`HB_WEBGL_BIND` → wg0 IPv4 → 127.0.0.1**, never 0.0.0.0 by default; `/__hb_webgl_v` + index poller) |
| Preset | `webgl` action = live view; port arg synced on upsert |
| Bridge coordination | **Stop this project’s Coplay bridge before each batchmode build** (project lock). Do not use `manage_build` for this path — documented in scripts + workspace README |
| UI | Apps iframe + open-on-phone link once port is up |

### Step 5 — Sample (`~/MCP_WORKSPACES/unity-sample`)

| Item | Result |
|------|--------|
| Scene | Rotating cube + TextMesh “Hello from DevCon1” (no holiday theme) |
| Build | `scripts/unity/build-webgl.sh` → `Builds/WebGL` |
| Serve | Leave `serve-webgl.sh` / live on port **8410** (or assigned project port) |
| URL | **`http://10.6.0.1:8410/`** — curl OK: `index.html` 200 `text/html`; `WebGL.wasm.gz` 200 `application/wasm` + `Content-Encoding: gzip`; `WebGL.data.gz` 200 + gzip; left serving via `serve-webgl.sh` |

### QA steps (after Dan `./build.sh --deploy`)

1. Settings → Unity: Editor check **OK** (no longer “Hub yes / Editor no” under the service).
2. Register / open `unity-sample` (unity preset); Start **WebGL live view**.
3. Phone on VPN: open `http://10.6.0.1:<webgl-port>/` and confirm cube + text; iframe on Apps card at ~390×844.
4. Touch an Asset under `Assets/` → wait debounce → page auto-reloads.
5. View tab: idle text says laptop screen ≠ Unity; Max works while connecting.
6. Do **not** run bridge + WebGL live on the same project at once (live stops bridge for builds).

### Human next steps

1. Deploy: `./build.sh --deploy` (agent must not self-deploy).
2. Confirm sample still serving after deploy (restart may kill the PTY serve — re-Start WebGL live view).

---

## Appendix — Redaction policy

This document intentionally omits: account emails, serials, access/refresh tokens, machine-binding secrets, MCP auth tokens, and vault material. License reporting is limited to product tier (Personal) and file presence.
