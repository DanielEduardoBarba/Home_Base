# Unity MCP tools (Home Base)

Remote bots talk to Home Base over the VPN MCP HTTP endpoint. They **cannot** reach the Coplay Unity bridge on `127.0.0.1:6400` directly — use these `homebase_unity_*` tools instead.

Feature group: **projects** (same master MCP token + Projects feature toggle). Mutating tools are omitted on readonly surfaces.

## Tool list

| Tool | Args | Notes |
|------|------|--------|
| `homebase_unity_status` | `projectId?` | Hub/Editor/modules (WebGL, iOS)/license. With `projectId`: bridge reachability, editor lock, last WebGL build, recent jobs. |
| `homebase_unity_bridge` | `projectId`, `action`=`start`\|`stop`\|`status` | One Editor per project; start/stop the Coplay bridge action. |
| `homebase_unity_list_tools` | `projectId` | Static Coplay catalog + live `manage_tools` when bridge is up. |
| `homebase_unity_call` | `projectId`, `tool`, `args?`, `timeoutMs?` | Framed TCP proxy to the project bridge. Key remote path. |
| `homebase_unity_log_tail` | `projectId`, `source?`=`editor`\|`webgl`\|`bridge`, `lines?` | Redacted log tails. |
| `homebase_unity_run_tests` | `projectId`, `mode?`=`EditMode`\|`PlayMode` | Async batchmode tests → `jobId`. |
| `homebase_unity_build_webgl` | `projectId` | Async: stop bridge → build → restart preview → `jobId`. |
| `homebase_unity_preview_status` | `projectId` | WebGL URL/port/build presence. |
| `homebase_unity_refresh_scripts` | `projectId` | Re-copy `scripts/unity/*` + re-apply unity preset actions; preserves ports; no game-code changes. |
| `homebase_unity_screenshot` | `projectId` | Bridge `manage_camera` screenshot → path + optional base64. |
| `homebase_unity_job_status` | `jobId` | Poll async build/test jobs. |
| `homebase_unity_job_list` | `limit?` | Recent Unity jobs. |

Related (not Unity-prefixed):

- `homebase_create_mcp_workspace` `{ name, preset: "unity" }` — seat-owned `Unity -createProject` + Coplay package + scripts (HB-U-03).
- `homebase_project_upsert` `{ path, refreshUnityScripts: true }` — same refresh as `homebase_unity_refresh_scripts` (by id or after upsert).
- `homebase_github_create_repo` — empty workspace gets Unity `.gitignore` + initial commit + `development_grok` / `development` (HB-U-04).
- `homebase_run_action` — preset actions: `unity_dev` (bridge+preview), `editor`, `webgl_build`, `webgl_serve`, `webgl` (live), `stop`.

## Examples

```json
{ "name": "homebase_unity_status", "arguments": { "projectId": "my-game" } }
```

```json
{
  "name": "homebase_unity_bridge",
  "arguments": { "projectId": "my-game", "action": "start" }
}
```

```json
{
  "name": "homebase_unity_call",
  "arguments": {
    "projectId": "my-game",
    "tool": "manage_scene",
    "args": { "action": "get_hierarchy" }
  }
}
```

```json
{
  "name": "homebase_unity_build_webgl",
  "arguments": { "projectId": "my-game" }
}
```

Then poll:

```json
{ "name": "homebase_unity_job_status", "arguments": { "jobId": "uj_…" } }
```

## Framing

Coplay handshake: `WELCOME UNITY-MCP 1 FRAMING=1\n`  
Payload: 8-byte big-endian length + UTF-8 body.  
`ping` sends raw `ping` bytes; other tools send `{"type":"<tool>","params":{…}}`.

## Gaps

- Screenshot needs a running bridge (no headless WebGL pixel grab yet).
- Live `manage_tools` list requires bridge up; otherwise static catalog only.
- Async jobs are in-memory (+ optional runtime JSON); cleared on homebased restart.
