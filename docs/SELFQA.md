# Self-QA sprint

Automated cyclic **Dev + QA** loop that mirrors DevCon1’s bot team (Developer, QA Manager, tester personas), running on the **Cursor agent CLI** (`cursor-agent` / verified `agent`, headless print mode, model **auto**) so it uses the laptop Cursor pool instead of Grok Bot.

Enforced rules: `docs/qa/selfqa-qa-spec.md`.

## Requirements

- Cursor CLI on `PATH` (`cursor-agent` preferred; bare `agent` only if `--help` identifies Cursor). Not required for `--dry-run`.
- Current git branch must be **`development_grok`** (live runs refuse otherwise).
- Project `./build.sh --selfqa` (Home Base ships this; other apps use a thin wrapper — below).

## CLI

```bash
./build.sh --selfqa --goal "Close open findings and harden login" --cycles 3 --max-minutes 90 --testers 3
./build.sh --selfqa --dry-run --goal "preview only"
```

| Option | Default | Meaning |
|---|---|---|
| `--goal` / `--goal-file` | backlog stub | Sprint goal (**mutually exclusive**) |
| `--cycles N` | 3 | Max Dev→QA cycles |
| `--max-minutes M` | 90 | Wall-clock cap |
| `--testers K` | 3 (max 6) | Tester agents (warns when capped) |
| `--dry-run` | off | Print full plan; **write nothing**; exit 0 even without CLI |

**Exit codes:** `0` PASS · `2` BLOCKED / caps with open findings · `1` error (wrong branch, bad args, agent/guardrail failure).

**Agent flag:** headless runs keep Cursor CLI `--force` so print mode does not prompt (documented in runner `--help`).

## Using the shared runner from another app

Apps should **not** copy the full Self-QA kit. Keep a thin `build.sh` wrapper that points at Home Base:

```bash
# In your app's build.sh — example thin wrapper
--selfqa)
  shift
  HOMEBASE_ROOT="${HOMEBASE_ROOT:-$HOME/APP_PROJECTS/GENERAL/home_base}"
  SELFQA_RUNNER="${SELFQA_RUNNER:-$HOMEBASE_ROOT/scripts/selfqa/run.sh}"
  if [[ ! -x "$SELFQA_RUNNER" && ! -f "$SELFQA_RUNNER" ]]; then
    echo "Self-QA runner not found: $SELFQA_RUNNER (set HOMEBASE_ROOT or SELFQA_RUNNER)" >&2
    exit 1
  fi
  exec env SELFQA_TARGET_ROOT="$ROOT" bash "$SELFQA_RUNNER" "$@"
  ;;
```

| Env | Meaning |
|---|---|
| `SELFQA_TARGET_ROOT` | App repo under test (set by the wrapper to `$ROOT`) |
| `HOMEBASE_ROOT` / `SELFQA_RUNNER` | Where the shared `scripts/selfqa/run.sh` lives |
| `SELFQA_AGENT_TIMEOUT_SEC` | Per-agent timeout (default 900) |

Prompts stay under Home Base `scripts/selfqa/prompts/`. Run artifacts are written into the **target** app’s `docs/selfqa/` and `docs/qa/`.

## Roles (per cycle)

Each role is a separate headless agent run; state is shared under `docs/selfqa/<run-id>/`.

1. **Orchestrator** — goal + `docs/QA-PROGRESS.md` + open `docs/qa/` findings → plan.
2. **Developer** — fix on `development_grok`, typecheck + tests, commit/push (no force).
3. **QA Manager** — test plan, spawn testers, write cycle report + strict `VERDICT.json`.
4. **Testers** — persona workflows against localhost only; personas get `qa+personaN@example.test` emails.

## Home Base UI

Work → Apps → **Cursor jobs** (Cancel on running MCP jobs) and **Self-QA sprint** (Cancel on running sprints).

## MCP

Tool: **`homebase_selfqa`**. Cancel: **`homebase_cursor_job_cancel`** `{projectId, jobId?}` (also cancels Self-QA).

When the session ends, Home Base POSTs `type: "homebase.selfqa"` with a single `summary` JSON (`SUMMARY.json`: runId, rounds, verdict, commits, reportPaths, …).

## Guardrails (code-enforced)

Branch gate, localhost-only targets, repeat finding id → BLOCKED (exit 2), deploy/ship/firebase/eas/merge/force-push/wrong-branch push/deletes outside `docs/selfqa`/App Store/payment keys abort (exit 1). PASS only from `VERDICT.json` `{"verdict":"PASS"|"FAIL"|"BLOCKED"}`. See `scripts/selfqa/prompts/guardrails.md` and `docs/qa/selfqa-qa-spec.md`.
