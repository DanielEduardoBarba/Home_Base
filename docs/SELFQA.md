# Self-QA sprint

Automated cyclic **Dev + QA** loop that mirrors DevCon1’s bot team (Developer, QA Manager, tester personas), running on the **Cursor agent CLI** (`cursor-agent` / verified `agent`, headless print mode, model **auto**) so it uses the laptop Cursor pool instead of Grok Bot.

Enforced rules: `docs/qa/selfqa-qa-spec.md`. Implementation: Home Base `scripts/selfqa/` (shared runner).

## Requirements

- Cursor CLI on `PATH` (`cursor-agent` preferred; bare `agent` only after `agent --version` verifies it is Cursor’s). Not required for `--dry-run`.
- `./build.sh --setup` / `--onboarding` install the official Cursor Agent CLI if missing (`curl https://cursor.com/install -fsS | bash`) and verify with `agent --version`. Setup never runs `agent login` — Dan signs in interactively.
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

## Using the shared runner from another app (thin wrapper)

Apps should **not** copy `scripts/selfqa/` (StockWinter / Ekklesias / ClockTrakr copies can be replaced). Keep a thin `build.sh` flag that points at Home Base:

```bash
# In your app's build.sh — thin wrapper (replace local scripts/selfqa copies)
ROOT="$(cd "$(dirname "$0")" && pwd)"   # or your existing ROOT
# …
--selfqa)
  shift
  HOMEBASE_ROOT="${HOMEBASE_ROOT:-$HOME/APP_PROJECTS/GENERAL/home_base}"
  SELFQA_RUNNER="${SELFQA_RUNNER:-$HOMEBASE_ROOT/scripts/selfqa/run.sh}"
  if [[ ! -f "$SELFQA_RUNNER" ]]; then
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
| `SELFQA_CALLBACK_URL` / `SELFQA_CALLBACK_AUTH` | Optional end-of-run HTTP callback |

Prompts stay under Home Base `scripts/selfqa/prompts/`. Run artifacts are written into the **target** app’s `docs/selfqa/` and `docs/qa/`.

### Callback payload

`docs/selfqa/<runId>/callback.json` (also mirrored fields in `SUMMARY.json`) includes at least:

`runId`, `branch`, `rounds`, `verdict`, `commit`, `docsCommit`, `typecheck`, `tests`, `items`, `bugs`, `reportPaths`.

The die/error path still emits **one** callback (then restores `core.hooksPath`).

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

**Where commands run (primary):**

- Temporary `core.hooksPath` pre-push: only `development_grok` → `origin/development_grok`; no force/delete; restored on EXIT even on failure.
- Agent env: `SELFQA_RUN=1`, blank deploy tokens/keys, temp `HOME` / `XDG_CONFIG_HOME` / `CLOUDSDK_CONFIG`.
- PATH shims refuse `ship.sh` / `deploy*.sh` / `ship-expo.sh` / `build.sh --deploy|--ship|d|a|s|m` / `pnpm deploy*` / `firebase|eas|gcloud` deploy / `xcrun altool`.

**Text scan (second layer):** normalizes commands (split on `;` `&&` `||` `|` `$()`, strip env/`cd`, resolve basename). Catches ship/deploy forms, unsafe `git push`, price/subscription phrasing. Skips prose like “I will not run ./ship.sh”. Only **open** finding ids (not Pass/fixed/closed/verified) feed the consecutive-round BLOCKED rule.

See `scripts/selfqa/prompts/guardrails.md` and `docs/qa/selfqa-qa-spec.md`.
