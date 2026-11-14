# Self-QA QA Spec (enforced in runner code)

This spec is implemented by `scripts/selfqa/` (not prompt-only). Apps should call the shared Home Base runner via a thin `build.sh --selfqa` wrapper — see `docs/SELFQA.md`.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | `verdict: PASS` |
| 2 | Caps / open findings / `BLOCKED` (repeat finding id, guardrail block) |
| 1 | Error (wrong branch, bad args, missing CLI when not dry-run, agent failure, guardrail abort) |

## HIGH (must enforce in code)

1. **Branch gate** — refuse (exit 1) unless the target repo’s current branch is exactly `development_grok`.
2. **Localhost-only targets** — refuse (exit 1) if the goal / plan names non-localhost http(s) write targets.
3. **Repeat finding block** — if the same finding id appears as open in **2 consecutive** cycles, stop early with verdict `BLOCKED` (exit 2).
4. **Guardrail abort** — before and after each agent step, scan git + agent logs and abort (exit 1) on:
   - deploy / ship / `firebase deploy` / `eas submit`
   - `git merge`
   - `git push` to any branch other than `development_grok`
   - force-push (`--force` / `--force-with-lease` on push)
   - branch deletion or file deletion outside `docs/selfqa/` scratch
   - App Store Connect / price or subscription changes / real payment keys
5. **Agent CLI `--force`** — headless print mode keeps `--force` so the Cursor CLI does not prompt; documented in runner help. Prefer avoiding unrelated force flags.
6. **Strict verdict** — PASS/FAIL/BLOCKED only from a JSON file `VERDICT.json` shaped as `{"verdict":"PASS"|"FAIL"|"BLOCKED"}`. Never decide PASS by grepping markdown.

## MEDIUM

1. **Per-agent timeout** — each agent invocation is wrapped with a wall timeout (default 15 minutes; overridable via `SELFQA_AGENT_TIMEOUT_SEC`).
2. **Single callback summary** — write one `SUMMARY.json` (`runId`, `rounds`, `verdict`, `commits`, `reportPaths`, …). Home Base webhooks send this JSON as the primary callback body.
3. **Agent failures propagate** — non-zero agent exit → runner exit 1 (unless dry-run).
4. **`--dry-run`** — prints the full plan to stdout, writes nothing, exits 0 even when the Cursor CLI is absent.
5. **Reports / handoff** — each cycle writes `docs/qa/selfqa-<runId>-cycleN.md` plus run dir artifacts under `docs/selfqa/<runId>/`. Final handoff is `SUMMARY.md` + `SUMMARY.json`.

## LOW

1. Prefer `cursor-agent`; use `agent` only after verifying it is the Cursor CLI (`--help` mentions Cursor).
2. `--goal` and `--goal-file` are mutually exclusive.
3. Warn when `--testers` is capped at 6.
4. Tester personas get labeled QA emails (`qa+personaN@example.test`).

## App integration (thin wrapper)

```bash
# In an app's build.sh:
--selfqa)
  HOMEBASE_ROOT="${HOMEBASE_ROOT:-$HOME/APP_PROJECTS/GENERAL/home_base}"
  # Or: SELFQA_RUNNER=/path/to/home_base/scripts/selfqa/run.sh
  exec env SELFQA_TARGET_ROOT="$ROOT" \
    "${SELFQA_RUNNER:-$HOMEBASE_ROOT/scripts/selfqa/run.sh}" "$@"
  ;;
```

`SELFQA_TARGET_ROOT` (default: cwd) is the app repo under test. The runner lives in Home Base and is shared.
