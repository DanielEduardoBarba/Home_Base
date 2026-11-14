# Self-QA sprint

Automated cyclic **Dev + QA** loop that mirrors DevCon1’s bot team (Developer, QA Manager, tester personas), running on the **Cursor agent CLI** (`cursor-agent` / `agent`, headless print mode, model **auto**) so it uses the laptop Cursor pool instead of Grok Bot.

## Requirements

- Cursor CLI on `PATH` (`agent` or `cursor-agent`). Install: [Cursor headless CLI](https://cursor.com/docs/cli/headless).
- Project `./build.sh --selfqa` (Home Base ships this; other apps must add the flag or copy `scripts/selfqa/`).

## CLI

```bash
./build.sh --selfqa --goal "Close open findings and harden login" --cycles 3 --max-minutes 90 --testers 3
./build.sh --selfqa --dry-run --goal "preview only"
```

| Option | Default | Meaning |
|---|---|---|
| `--goal` / `--goal-file` | backlog stub | Sprint goal |
| `--cycles N` | 3 | Max Dev→QA cycles |
| `--max-minutes M` | 90 | Wall-clock cap |
| `--testers K` | 3 (max 6) | Tester agents |
| `--dry-run` | off | Print plan; no agent calls |

**Exit codes:** `0` PASS · `2` caps with open findings · `1` error (missing CLI, bad args, …).

## Roles (per cycle)

Each role is a separate headless agent run; state is shared under `docs/selfqa/<run-id>/`.

1. **Orchestrator** — goal + `docs/QA-PROGRESS.md` + open `docs/qa/` findings → plan.
2. **Developer** — fix on `development_grok`, typecheck + tests, commit/push (no force).
3. **QA Manager** — test plan, spawn testers, write `docs/qa/selfqa-<run-id>-cycleN.md`, PASS/FAIL.
4. **Testers** — persona workflows against localhost/emulators only.

Prompts: `scripts/selfqa/prompts/*.md` (editable). Runner: `scripts/selfqa/run.sh`.

## Home Base UI

Work → Apps → **Self-QA sprint**: goal, cycles/minutes/testers, dry-run, Start/Stop, live session output, latest report path.

## MCP

```json
{
  "projectId": "homebase",
  "goal": "…",
  "cycles": 3,
  "maxMinutes": 90,
  "testers": 3,
  "dryRun": false,
  "callbackUrl": "__JOB_DONE_WEBHOOK__",
  "callbackAuth": "Bearer …"
}
```

Tool: **`homebase_selfqa`**. One Self-QA session per `projectId`. When the session ends, Home Base POSTs `type: "homebase.selfqa"` with `exitCode`, `summaryPath`, and `summaryTail`.

`homebase_run_action` also accepts `callbackUrl` / `callbackAuth` (fires when the action’s PTY session(s) exit). `actionId: "selfqa"` starts the same sprint.

If `build.sh` lacks `--selfqa`, the tool/UI returns a clear error.

## Guardrails

No deploys/ship, no App Store/Play, no real payments or customer data, local/emulator only, no force-push, never merge to `development`/`main`, no secrets in logs/commits. Full list in `scripts/selfqa/prompts/guardrails.md`.
