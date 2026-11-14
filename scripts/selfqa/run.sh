#!/usr/bin/env bash
# Self-QA sprint runner — shared Home Base implementation (Cursor agent CLI).
# Invoked by: ./build.sh --selfqa [options]
# Other apps: set SELFQA_TARGET_ROOT + exec this script (see docs/SELFQA.md).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

# Repo under test (app). Runner kit stays in Home Base scripts/selfqa.
TARGET_ROOT="$(cd "${SELFQA_TARGET_ROOT:-.}" && pwd)"
PROMPTS_DIR="$SCRIPT_DIR/prompts"
cd "$TARGET_ROOT"

GOAL=""
GOAL_FILE=""
CYCLES=3
MAX_MINUTES=90
TESTERS=3
DRY_RUN=false
GOAL_SET=false
GOAL_FILE_SET=false

usage() {
  cat <<EOF
Self-QA · cyclic Dev + QA sprint (Cursor agent CLI)

USAGE
  ./build.sh --selfqa [options]
  SELFQA_TARGET_ROOT=/path/to/app scripts/selfqa/run.sh [options]

OPTIONS
  --goal "text"          Sprint goal (mutually exclusive with --goal-file)
  --goal-file PATH       Read goal from file (mutually exclusive with --goal)
  --cycles N             Max cycles (default 3)
  --max-minutes M        Wall-clock cap (default 90)
  --testers K            QA tester agents (default 3, max 6)
  --dry-run              Print full plan only; write nothing; exit 0 (CLI optional)
  -h, --help             This help

ENV
  SELFQA_TARGET_ROOT     App repo path (default: cwd)
  SELFQA_AGENT_TIMEOUT_SEC  Per-agent timeout seconds (default 900)
  SELFQA_REQUIRED_BRANCH Branch gate (default development_grok)
  SELFQA_CALLBACK_URL    Optional POST target for final callback.json
  SELFQA_CALLBACK_AUTH   Optional Authorization header for callback

NOTES
  Headless agent invocations use \`--force\` so the Cursor CLI does not prompt
  in print mode. No other force flags are used.
  Runtime guards (real runs): run-scoped pre-push hook, PATH deploy shims,
  blank deploy credentials / temp HOME. Text scan is a second layer only.

EXIT
  0  PASS
  2  BLOCKED / caps with open findings
  1  Error (branch, args, CLI, agent failure, guardrail abort)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --goal) GOAL="${2:-}"; GOAL_SET=true; shift 2 ;;
    --goal-file) GOAL_FILE="${2:-}"; GOAL_FILE_SET=true; shift 2 ;;
    --cycles) CYCLES="${2:-3}"; shift 2 ;;
    --max-minutes) MAX_MINUTES="${2:-90}"; shift 2 ;;
    --testers) TESTERS="${2:-3}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$GOAL_SET" == true && "$GOAL_FILE_SET" == true ]]; then
  echo "Error: --goal and --goal-file are mutually exclusive" >&2
  exit 1
fi

if [[ "$GOAL_FILE_SET" == true ]]; then
  if [[ ! -f "$GOAL_FILE" ]]; then
    echo "Error: --goal-file not found: $GOAL_FILE" >&2
    exit 1
  fi
  GOAL="$(cat "$GOAL_FILE")"
fi
GOAL="$(printf '%s' "$GOAL" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [[ -z "$GOAL" ]]; then
  GOAL="Improve quality: close open findings in docs/qa/ and advance docs/QA-PROGRESS.md."
fi

if ! [[ "$CYCLES" =~ ^[0-9]+$ ]] || [[ "$CYCLES" -lt 1 ]]; then
  echo "Error: --cycles must be a positive integer" >&2
  exit 1
fi
if ! [[ "$MAX_MINUTES" =~ ^[0-9]+$ ]] || [[ "$MAX_MINUTES" -lt 1 ]]; then
  echo "Error: --max-minutes must be a positive integer" >&2
  exit 1
fi
if ! [[ "$TESTERS" =~ ^[0-9]+$ ]] || [[ "$TESTERS" -lt 1 ]]; then
  echo "Error: --testers must be a positive integer" >&2
  exit 1
fi
if [[ "$TESTERS" -gt 6 ]]; then
  echo "warn: --testers capped at 6 (requested $TESTERS)" >&2
  TESTERS=6
fi

print_plan() {
  local agent_label="${1:-"(not required for dry-run)"}"
  cat <<EOF
# Self-QA plan

- target: \`$TARGET_ROOT\`
- branch required: \`$SELFQA_REQUIRED_BRANCH\`
- cycles: $CYCLES · max-minutes: $MAX_MINUTES · testers: $TESTERS
- agent timeout: ${SELFQA_AGENT_TIMEOUT_SEC}s
- agent: \`$agent_label\` (model auto, print mode; keeps --force for non-interactive)
- goal: $GOAL

## Loop
Orchestrator → Developer → QA Manager → $TESTERS tester(s) → Orchestrator … until PASS or caps.

## Artifacts (when not dry-run)
- Run dir: \`docs/selfqa/<runId>/\`
- Cycle reports: \`docs/qa/selfqa-<runId>-cycleN.md\`
- Verdict: \`docs/selfqa/<runId>/VERDICT.json\` — {"verdict":"PASS"|"FAIL"|"BLOCKED","openFindings":[{"id","severity","title"},...]}
- Final: \`SUMMARY.md\` + \`SUMMARY.json\` + \`callback.json\` (single callback payload)

## Guardrails
Runtime: pre-push hook (development_grok→origin/development_grok only), PATH shims for
ship/deploy/firebase/eas/gcloud, blank deploy credentials. Text scan (normalized
commands) is a second layer; prose like "I will not run ./ship.sh" is ignored.
EOF
}

if [[ "$DRY_RUN" == true ]]; then
  AGENT_BIN="(dry-run)"
  if AGENT_BIN="$(selfqa_detect_agent 2>/dev/null)"; then
    :
  else
    AGENT_BIN="(Cursor CLI not installed — ok for dry-run)"
  fi
  print_plan "$AGENT_BIN"
  echo
  echo "Dry-run complete — no files written."
  exit 0
fi

# --- live run gates ---
if ! selfqa_require_branch "$TARGET_ROOT"; then
  exit 1
fi
if ! selfqa_localhost_only_text "$GOAL"; then
  exit 1
fi

AGENT_BIN=""
if ! AGENT_BIN="$(selfqa_detect_agent)"; then
  echo "Error: Cursor agent CLI not found or failed agent --version verification." >&2
  selfqa_agent_install_hint >&2
  exit 1
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_DIR="$TARGET_ROOT/docs/selfqa/$RUN_ID"
LOG_DIR="$RUN_DIR/logs"
mkdir -p "$LOG_DIR" "$RUN_DIR/testers" "$TARGET_ROOT/docs/qa"
START_EPOCH="$(date +%s)"
DEADLINE=$((START_EPOCH + MAX_MINUTES * 60))
BRANCH="$SELFQA_REQUIRED_BRANCH"
COMMITS_FILE="$RUN_DIR/commits.txt"
: >"$COMMITS_FILE"
FINDINGS_PREV=""
FINDINGS_CUR=""
REPORT_PATHS=()
LAST_QA_REPORT=""
FINAL_VERDICT="FAIL"
OPEN_FINDINGS=1
CYCLE=0
CALLBACK_URL="${SELFQA_CALLBACK_URL:-}"
CALLBACK_AUTH="${SELFQA_CALLBACK_AUTH:-}"
CALLBACK_SENT=false
DOCS_COMMIT="$(git -C "$TARGET_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
TYPECHECK_STATUS="not_run"
TESTS_JSON='{"expected":null,"passed":null,"failed":null}'
ITEMS_JSON="[]"
BUGS_JSON='{"high":[],"medium":[],"low":[]}'
BLOCK_REASON=""

# Runtime enforcement dirs
HOOKS_DIR="$RUN_DIR/hooks"
HOOKS_STATE="$RUN_DIR/hooks-state.txt"
SCRIPT_GUARDS_STATE="$RUN_DIR/script-guards-state.txt"
SHIM_DIR="$RUN_DIR/shims"
AGENT_HOME="$RUN_DIR/agent-home"
REAL_HOME="${HOME:-/tmp}"

PERSONAS=(
  "Manager — reviews dashboards, approvals, and team workflows"
  "Employee — day-to-day task flows and mobile-ish viewports"
  "Contractor — limited access; verify permissions and demos"
  "Owner — billing/settings and onboarding edges"
  "Member — happy-path member experience"
  "Guest — read-only / logged-out edges where safe"
)

write_state() {
  local cycle="$1" phase="$2" verdict="${3:-}"
  cat >"$RUN_DIR/STATE.json" <<EOF
{
  "runId": "$RUN_ID",
  "branch": "$BRANCH",
  "cycle": $cycle,
  "cycles": $CYCLES,
  "maxMinutes": $MAX_MINUTES,
  "testers": $TESTERS,
  "phase": "$phase",
  "verdict": "$verdict",
  "startedAt": $START_EPOCH,
  "deadline": $DEADLINE,
  "agentBin": "$AGENT_BIN",
  "lastQaReport": "${LAST_QA_REPORT:-}"
}
EOF
}

refresh_callback_fields() {
  # Best-effort: docsCommit + typecheck/tests/items/bugs from reports/logs.
  local meta_file
  meta_file="$(mktemp)"
  if ! selfqa_refresh_callback_meta "$TARGET_ROOT" "$RUN_DIR" \
    "${REPORT_PATHS[@]+"${REPORT_PATHS[@]}"}" >"$meta_file" 2>/dev/null; then
    DOCS_COMMIT="$(git -C "$TARGET_ROOT" rev-parse HEAD 2>/dev/null || echo "${DOCS_COMMIT:-unknown}")"
    rm -f "$meta_file"
    return 0
  fi
  if [[ ! -s "$meta_file" ]]; then
    DOCS_COMMIT="$(git -C "$TARGET_ROOT" rev-parse HEAD 2>/dev/null || echo "${DOCS_COMMIT:-unknown}")"
    rm -f "$meta_file"
    return 0
  fi
  eval "$(python3 - "$meta_file" <<'PY'
import json, shlex, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
docs = d.get("docsCommit") or ""
tc = d.get("typecheck") or "not_run"
tests = json.dumps(d.get("tests") or {"expected": None, "passed": None, "failed": None})
items = json.dumps(d.get("items") or [])
bugs = json.dumps(d.get("bugs") or {"high": [], "medium": [], "low": []})
print(f"DOCS_COMMIT={shlex.quote(docs)}")
print(f"TYPECHECK_STATUS={shlex.quote(tc)}")
print(f"TESTS_JSON={shlex.quote(tests)}")
print(f"ITEMS_JSON={shlex.quote(items)}")
print(f"BUGS_JSON={shlex.quote(bugs)}")
PY
)" || true
  [[ -n "${DOCS_COMMIT:-}" ]] || DOCS_COMMIT="$(git -C "$TARGET_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  rm -f "$meta_file"
}

write_callback_json() {
  local path="$1"
  refresh_callback_fields || true
  local shortsha fullsha
  shortsha="$(git -C "$TARGET_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  fullsha="$(git -C "$TARGET_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  local reports_file="$RUN_DIR/report_paths.txt"
  : >"$reports_file"
  local r
  for r in "${REPORT_PATHS[@]+"${REPORT_PATHS[@]}"}"; do
    [[ -n "$r" ]] && printf '%s\n' "$r" >>"$reports_file"
  done
  python3 - "$path" "$RUN_ID" "$CYCLE" "$CYCLES" "$FINAL_VERDICT" \
    "$COMMITS_FILE" "$reports_file" "$fullsha" "$shortsha" "$BRANCH" \
    "$DOCS_COMMIT" "$TYPECHECK_STATUS" "$TESTS_JSON" "$ITEMS_JSON" "$BUGS_JSON" \
    "$BLOCK_REASON" "$TARGET_ROOT" <<'PY'
import json, sys
from pathlib import Path
(
    out, run_id, rounds, cap, verdict, commits_f, reports_f,
    fullsha, shortsha, branch, docs_commit, typecheck, tests_s,
    items_s, bugs_s, reason, root,
) = sys.argv[1:18]

def lines(p):
    try:
        return [ln.strip() for ln in open(p, encoding="utf-8") if ln.strip()]
    except FileNotFoundError:
        return []

try:
    tests = json.loads(tests_s)
except Exception:
    tests = {"expected": None, "passed": None, "failed": None}
try:
    items = json.loads(items_s)
except Exception:
    items = []
try:
    bugs = json.loads(bugs_s)
except Exception:
    bugs = {"high": [], "medium": [], "low": []}

payload = {
    "app": Path(root).name,
    "runId": run_id,
    "branch": branch,
    "rounds": int(rounds or 0),
    "round": int(rounds or 0),
    "cyclesCap": int(cap or 0),
    "verdict": verdict,
    "commit": fullsha,
    "shortCommit": shortsha,
    "docsCommit": docs_commit,
    "typecheck": typecheck,
    "tests": tests,
    "items": items,
    "bugs": bugs,
    "commits": lines(commits_f),
    "reportPaths": lines(reports_f),
    "reportPath": (lines(reports_f)[-1] if lines(reports_f) else None),
    "summaryPath": f"docs/selfqa/{run_id}/SUMMARY.md",
    "verdictPath": f"docs/selfqa/{run_id}/VERDICT.json",
    "reason": reason or None,
}
payload = {k: v for k, v in payload.items() if v is not None}
open(out, "w", encoding="utf-8").write(json.dumps(payload, indent=2) + "\n")
PY
}

write_summary() {
  refresh_callback_fields || true
  local elapsed=$(( ($(date +%s) - START_EPOCH) / 60 ))
  local reports_file="$RUN_DIR/report_paths.txt"
  : >"$reports_file"
  local r
  for r in "${REPORT_PATHS[@]+"${REPORT_PATHS[@]}"}"; do
    [[ -n "$r" ]] && printf '%s\n' "$r" >>"$reports_file"
  done
  python3 - "$RUN_DIR/SUMMARY.json" "$RUN_ID" "$CYCLE" "$CYCLES" "$FINAL_VERDICT" \
    "$COMMITS_FILE" "$reports_file" "$elapsed" "$MAX_MINUTES" "$TESTERS" "$GOAL" \
    "$AGENT_BIN" "$BRANCH" "$LAST_QA_REPORT" "$DOCS_COMMIT" "$TYPECHECK_STATUS" \
    "$TESTS_JSON" "$ITEMS_JSON" "$BUGS_JSON" <<'PY'
import json, sys
(
    out, run_id, rounds, cap, verdict, commits_f, reports_f, elapsed, max_m,
    testers, goal, agent, branch, last, docs_commit, typecheck, tests_s,
    items_s, bugs_s,
) = sys.argv[1:20]

def lines(p):
    try:
        return [ln.strip() for ln in open(p, encoding="utf-8") if ln.strip()]
    except FileNotFoundError:
        return []

def loads(s, default):
    try:
        return json.loads(s)
    except Exception:
        return default

payload = {
    "runId": run_id,
    "rounds": int(rounds or 0),
    "cyclesCap": int(cap or 0),
    "verdict": verdict,
    "commits": lines(commits_f),
    "reportPaths": lines(reports_f),
    "summaryPath": f"docs/selfqa/{run_id}/SUMMARY.md",
    "verdictPath": f"docs/selfqa/{run_id}/VERDICT.json",
    "elapsedMinutes": int(elapsed or 0),
    "maxMinutes": int(max_m or 0),
    "testers": int(testers or 0),
    "goal": goal,
    "agent": agent,
    "branch": branch,
    "lastQaReport": last or None,
    "docsCommit": docs_commit,
    "typecheck": typecheck,
    "tests": loads(tests_s, {}),
    "items": loads(items_s, []),
    "bugs": loads(bugs_s, {}),
}
open(out, "w", encoding="utf-8").write(json.dumps(payload, indent=2) + "\n")
PY
  cat >"$RUN_DIR/SUMMARY.md" <<EOF
# Self-QA SUMMARY

- runId: $RUN_ID
- verdict: $FINAL_VERDICT
- cyclesCompleted: $CYCLE
- cyclesCap: $CYCLES
- elapsedMinutes: $elapsed
- maxMinutes: $MAX_MINUTES
- testers: $TESTERS
- goal: $GOAL
- lastQaReport: ${LAST_QA_REPORT:-none}
- agent: $AGENT_BIN
- branch: $BRANCH
- docsCommit: $DOCS_COMMIT
- typecheck: $TYPECHECK_STATUS
- summaryJson: docs/selfqa/$RUN_ID/SUMMARY.json
- callbackJson: docs/selfqa/$RUN_ID/callback.json
EOF
  write_callback_json "$RUN_DIR/callback.json" || true
  echo "==> SUMMARY: $RUN_DIR/SUMMARY.md (verdict=$FINAL_VERDICT)"
}

selfqa_emit_callback() {
  if [[ "$CALLBACK_SENT" == true ]]; then
    return 0
  fi
  CALLBACK_SENT=true
  mkdir -p "$RUN_DIR"
  write_summary || true
  if [[ -n "$CALLBACK_URL" && -f "$RUN_DIR/callback.json" ]]; then
    selfqa_post_callback "$CALLBACK_URL" "$CALLBACK_AUTH" "$RUN_DIR/callback.json" || true
  fi
}

# Optional HTTP POST helper (StockWinter residual: die path still sends one callback).
selfqa_post_callback() {
  local url="${1:-}"
  local auth="${2:-}"
  local json_file="${3:-}"
  [[ -n "$url" ]] || return 0
  [[ -f "$json_file" ]] || return 1
  local args=(-sS -X POST -H "Content-Type: application/json" --data-binary @"$json_file")
  if [[ -n "$auth" ]]; then
    args+=(-H "Authorization: $auth")
  fi
  curl "${args[@]}" "$url" >/dev/null || {
    echo "warn: SELFQA_CALLBACK_URL POST failed" >&2
    return 1
  }
  return 0
}

selfqa_restore_runtime_guards() {
  selfqa_restore_script_guards "$SCRIPT_GUARDS_STATE" || true
  selfqa_restore_hooks_path "$HOOKS_STATE" || true
}

selfqa_on_die() {
  local msg="${1:-error}"
  FINAL_VERDICT="${FINAL_VERDICT:-FAIL}"
  BLOCK_REASON="${BLOCK_REASON:-$msg}"
  cat >"$RUN_DIR/VERDICT.json" <<EOF
{"verdict":"FAIL","openFindings":[]}
EOF
  refresh_callback_fields || true
  selfqa_emit_callback || true
  selfqa_restore_runtime_guards || true
}

trap 'selfqa_restore_runtime_guards' EXIT

selfqa_install_pre_push_hook "$HOOKS_DIR" "$HOOKS_STATE" "$BRANCH"
selfqa_install_script_guards "$TARGET_ROOT" "$SCRIPT_GUARDS_STATE"
selfqa_create_path_shims "$SHIM_DIR" "$TARGET_ROOT"
selfqa_prepare_agent_home "$AGENT_HOME" "$REAL_HOME"

printf '%s\n' "$GOAL" >"$RUN_DIR/GOAL.md"
cp -f "$PROMPTS_DIR/guardrails.md" "$RUN_DIR/GUARDRAILS.md"
print_plan "$AGENT_BIN" >"$RUN_DIR/PLAN.md"

echo "==> Self-QA run $RUN_ID"
echo "    goal: $GOAL"
echo "    cycles=$CYCLES max-minutes=$MAX_MINUTES testers=$TESTERS agent=$AGENT_BIN"
echo "    guards: hooksPath + script guards + PATH shims + blank deploy env"
echo "    dir: $RUN_DIR"

if [[ ! -f "$TARGET_ROOT/docs/QA-PROGRESS.md" ]]; then
  cat >"$TARGET_ROOT/docs/QA-PROGRESS.md" <<EOF
# QA Progress

Self-QA and manual QA notes for this repository.

EOF
fi

snapshot_git() {
  git -C "$TARGET_ROOT" rev-parse HEAD 2>/dev/null || echo "NOHEAD"
}

record_commits_since() {
  local before="$1"
  local after
  after="$(snapshot_git)"
  if [[ "$before" != "$after" && "$before" != "NOHEAD" && "$after" != "NOHEAD" ]]; then
    git -C "$TARGET_ROOT" log --oneline "${before}..${after}" >>"$COMMITS_FILE" 2>/dev/null || true
  fi
}

abort_guardrail() {
  local why="$1"
  echo "GUARDRAIL ABORT: $why" | tee -a "$LOG_DIR/runner.log" >&2
  cat >"$RUN_DIR/VERDICT.json" <<EOF
{"verdict":"BLOCKED","openFindings":[]}
EOF
  FINAL_VERDICT="BLOCKED"
  BLOCK_REASON="$why"
  write_summary
  CALLBACK_SENT=true
  if [[ -n "$CALLBACK_URL" && -f "$RUN_DIR/callback.json" ]]; then
    selfqa_post_callback "$CALLBACK_URL" "$CALLBACK_AUTH" "$RUN_DIR/callback.json" || true
  fi
  exit 1
}

pre_post_scan() {
  local tag="$1"
  local logf="$2"
  local before_ref="$3"
  local scan_out="$LOG_DIR/guardrail-${tag}.txt"
  : >"$scan_out"
  if [[ -f "$logf" ]]; then
    if ! selfqa_scan_guardrails "$logf" "$TARGET_ROOT" >>"$scan_out" 2>&1; then
      abort_guardrail "forbidden pattern in agent log ($tag) — see $scan_out"
    fi
  fi
  if ! selfqa_scan_deletions "$TARGET_ROOT" "$before_ref"; then
    abort_guardrail "deletion outside docs/selfqa ($tag)"
  fi
}

run_agent() {
  local role="$1"
  local prompt_file="$2"
  local out_log="$3"
  local extra="${4:-}"
  local before
  before="$(snapshot_git)"
  local guardrails role_body prompt
  guardrails="$(cat "$PROMPTS_DIR/guardrails.md")"
  role_body="$(cat "$prompt_file")"
  prompt="$(cat <<EOF
You are running as Home Base Self-QA role: ${role}.
Working directory: ${TARGET_ROOT}
Run directory: ${RUN_DIR}
Read and obey these guardrails:

${guardrails}

---
Role instructions:

${role_body}

${extra}

Stay inside the repo. Prefer editing files under docs/selfqa/${RUN_ID}/ and docs/qa/.
When finished, ensure your role output file in the run directory is updated.
EOF
)"
  echo "---- agent role=$role ----" | tee -a "$LOG_DIR/runner.log"
  pre_post_scan "pre-$(basename "$out_log")" /dev/null "$before" || true
  set +e
  # --force kept for non-interactive Cursor CLI print mode (documented in --help).
  # SELFQA_RUN=1 + shims + blank deploy creds + temp HOME for CLI configs.
  selfqa_run_with_timeout "$SELFQA_AGENT_TIMEOUT_SEC" \
    env \
      SELFQA_RUN=1 \
      HOME="$AGENT_HOME" \
      XDG_CONFIG_HOME="$AGENT_HOME/.config" \
      CLOUDSDK_CONFIG="$AGENT_HOME/empty-gcloud" \
      FIREBASE_TOKEN= \
      GOOGLE_APPLICATION_CREDENTIALS= \
      GCLOUD_ACCESS_TOKEN= \
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE= \
      EXPO_TOKEN= \
      EAS_ACCESS_TOKEN= \
      EXPO_APPLE_PASSWORD= \
      APPLE_ID= \
      APPLE_APP_SPECIFIC_PASSWORD= \
      APP_STORE_CONNECT_API_KEY_PATH= \
      PATH="$SHIM_DIR:$PATH" \
      "$AGENT_BIN" -p --force --model auto --workspace "$TARGET_ROOT" "$prompt" \
    >"$out_log" 2>"$out_log.err"
  local rc=$?
  set -e
  cat "$out_log.err" >>"$out_log" 2>/dev/null || true
  pre_post_scan "post-$(basename "$out_log")" "$out_log" "$before"
  record_commits_since "$before"
  if [[ $rc -ne 0 ]]; then
    echo "Error: agent role=$role exited $rc (see $out_log)" | tee -a "$LOG_DIR/runner.log" >&2
    FINAL_VERDICT="FAIL"
    BLOCK_REASON="agent role=$role exited $rc"
    cat >"$RUN_DIR/VERDICT.json" <<EOF
{"verdict":"FAIL","openFindings":[]}
EOF
    write_summary
    CALLBACK_SENT=true
    if [[ -n "$CALLBACK_URL" && -f "$RUN_DIR/callback.json" ]]; then
      selfqa_post_callback "$CALLBACK_URL" "$CALLBACK_AUTH" "$RUN_DIR/callback.json" || true
    fi
    exit 1
  fi
  return 0
}

time_up() {
  [[ "$(date +%s)" -ge "$DEADLINE" ]]
}

for ((CYCLE = 1; CYCLE <= CYCLES; CYCLE++)); do
  if time_up; then
    echo "Time cap reached before cycle $CYCLE" | tee -a "$LOG_DIR/runner.log"
    break
  fi
  echo "==> Cycle $CYCLE / $CYCLES" | tee -a "$LOG_DIR/runner.log"
  write_state "$CYCLE" "orchestrator"

  run_agent "Orchestrator" "$PROMPTS_DIR/orchestrator.md" \
    "$LOG_DIR/cycle${CYCLE}-orchestrator.log" \
    "Current cycle: $CYCLE of $CYCLES. Update ORCHESTRATOR.md and PLAN.md."

  if time_up; then break; fi
  write_state "$CYCLE" "developer"
  run_agent "Developer" "$PROMPTS_DIR/developer.md" \
    "$LOG_DIR/cycle${CYCLE}-developer.log" \
    "Current cycle: $CYCLE. Fix findings then typecheck + tests; commit and push $BRANCH only (no force)."

  python3 - <<PY
import json
from pathlib import Path
run = Path("$RUN_DIR")
personas = """$(printf '%s\n' "${PERSONAS[@]}")""".strip().splitlines()
k = int("$TESTERS")
rows = []
for i in range(k):
    p = personas[i % len(personas)]
    email = f"qa+persona{i+1}@example.test"
    rows.append({"id": i + 1, "persona": p, "email": email})
    (run / "testers" / f"tester-{i+1}.md").write_text(
        f"# Tester {i+1}\n\nPersona: {p}\nQA email: {email}\n\n"
        f"Focus on realistic workflows for this persona.\n"
        f"Write your report to testers/report-{i+1}.md.\n",
        encoding="utf-8",
    )
(run / "TESTERS.json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
PY

  if time_up; then break; fi
  write_state "$CYCLE" "qa_manager_plan"
  run_agent "QA Manager" "$PROMPTS_DIR/qa_manager.md" \
    "$LOG_DIR/cycle${CYCLE}-qa-manager-plan.log" \
    "Phase: write TEST_PLAN.md and refine tester prompts. Testers will run next. Cycle $CYCLE. run-id $RUN_ID."

  for ((t = 1; t <= TESTERS; t++)); do
    if time_up; then break 2; fi
    write_state "$CYCLE" "tester_$t"
    run_agent "Tester $t" "$PROMPTS_DIR/tester.md" \
      "$LOG_DIR/cycle${CYCLE}-tester${t}.log" \
      "You are tester #$t. Read testers/tester-$t.md (includes QA email). Write testers/report-$t.md."
  done

  if time_up; then break; fi
  REPORT_PATH="docs/qa/selfqa-${RUN_ID}-cycle${CYCLE}.md"
  LAST_QA_REPORT="$REPORT_PATH"
  REPORT_PATHS+=("$REPORT_PATH")
  write_state "$CYCLE" "qa_manager_collect"
  run_agent "QA Manager" "$PROMPTS_DIR/qa_manager.md" \
    "$LOG_DIR/cycle${CYCLE}-qa-manager.log" \
    "Phase: collect tester reports and write $REPORT_PATH. Also write $RUN_DIR/VERDICT.json as strict JSON {\"verdict\":\"PASS\"|\"FAIL\"|\"BLOCKED\",\"openFindings\":[{\"id\":\"…\",\"severity\":\"high|medium|low\",\"title\":\"…\"},…]} (openFindings required; empty array when none) — never rely on markdown PASS text alone. Update QA_MANAGER.md and docs/QA-PROGRESS.md. Cycle $CYCLE. run-id $RUN_ID."

  if [[ ! -f "$TARGET_ROOT/$REPORT_PATH" ]]; then
    mkdir -p "$(dirname "$TARGET_ROOT/$REPORT_PATH")"
    cat >"$TARGET_ROOT/$REPORT_PATH" <<EOF
# Self-QA cycle $CYCLE ($RUN_ID)

QA Manager did not write this file. See run logs under docs/selfqa/$RUN_ID/logs/.
EOF
  fi

  # Strict verdict JSON only — never grep markdown for PASS.
  # Missing/malformed openFindings → fail closed BLOCKED + single callback.
  VERDICT="$(selfqa_read_verdict_json "$RUN_DIR/VERDICT.json")"
  if [[ -z "$VERDICT" ]]; then
    echo "Invalid VERDICT.json (missing/malformed openFindings or verdict) — fail closed BLOCKED" \
      | tee -a "$LOG_DIR/runner.log" >&2
    VERDICT="BLOCKED"
    cat >"$RUN_DIR/VERDICT.json" <<EOF
{"verdict":"BLOCKED","reason":"invalid_verdict","openFindings":[]}
EOF
    FINAL_VERDICT="BLOCKED"
    BLOCK_REASON="invalid_verdict"
    OPEN_FINDINGS=1
    write_state "$CYCLE" "blocked" "$VERDICT"
    write_summary
    CALLBACK_SENT=true
    if [[ -n "$CALLBACK_URL" && -f "$RUN_DIR/callback.json" ]]; then
      selfqa_post_callback "$CALLBACK_URL" "$CALLBACK_AUTH" "$RUN_DIR/callback.json" || true
    fi
    exit 2
  fi

  FINDINGS_CUR="$(mktemp)"
  # Source of truth: VERDICT.json openFindings. Report text is warning cross-check only.
  selfqa_extract_finding_ids "$RUN_DIR/VERDICT.json" "$TARGET_ROOT/$REPORT_PATH" \
    >"$FINDINGS_CUR" 2>>"$LOG_DIR/runner.log" || true
  if [[ -n "$FINDINGS_PREV" && -f "$FINDINGS_PREV" ]]; then
    if common="$(selfqa_repeat_findings "$FINDINGS_PREV" "$FINDINGS_CUR")"; then
      echo "Repeat finding id(s) across consecutive cycles: $common" | tee -a "$LOG_DIR/runner.log"
      VERDICT="BLOCKED"
      # Preserve openFindings from the current cycle for callback bugs/items.
      python3 - "$RUN_DIR/VERDICT.json" "$common" <<'PY'
import json, sys
path, common = sys.argv[1], sys.argv[2]
try:
    o = json.load(open(path, encoding="utf-8"))
except Exception:
    o = {}
if not isinstance(o, dict):
    o = {}
of = o.get("openFindings") if isinstance(o.get("openFindings"), list) else []
ids = [x for x in common.split() if x]
# Ensure repeated ids appear in openFindings for callback meta
have = {str(i.get("id") or "") for i in of if isinstance(i, dict)}
for fid in ids:
    if fid not in have:
        of.append({"id": fid, "severity": "high", "title": "repeat finding"})
        have.add(fid)
out = {"verdict": "BLOCKED", "reason": "repeat_finding", "ids": ids, "openFindings": of}
open(path, "w", encoding="utf-8").write(json.dumps(out) + "\n")
PY
      FINAL_VERDICT="BLOCKED"
      BLOCK_REASON="repeat_finding:$common"
      OPEN_FINDINGS=1
      write_state "$CYCLE" "blocked" "$VERDICT"
      rm -f "$FINDINGS_CUR"
      write_summary
      CALLBACK_SENT=true
      if [[ -n "$CALLBACK_URL" && -f "$RUN_DIR/callback.json" ]]; then
        selfqa_post_callback "$CALLBACK_URL" "$CALLBACK_AUTH" "$RUN_DIR/callback.json" || true
      fi
      exit 2
    fi
  fi
  if [[ -n "$FINDINGS_PREV" ]]; then rm -f "$FINDINGS_PREV"; fi
  FINDINGS_PREV="$FINDINGS_CUR"

  {
    echo
    echo "## Self-QA $RUN_ID cycle $CYCLE — $VERDICT"
    echo
    echo "- Report: \`$REPORT_PATH\`"
    echo "- Goal: $GOAL"
    date -u +"-% Timestamp: %Y-%m-%dT%H:%M:%SZ"
  } >>"$TARGET_ROOT/docs/QA-PROGRESS.md"

  write_state "$CYCLE" "done" "$VERDICT"
  if [[ "$VERDICT" == "PASS" ]]; then
    FINAL_VERDICT="PASS"
    OPEN_FINDINGS=0
    break
  fi
  if [[ "$VERDICT" == "BLOCKED" ]]; then
    FINAL_VERDICT="BLOCKED"
    OPEN_FINDINGS=1
    break
  fi
  FINAL_VERDICT="FAIL"
  OPEN_FINDINGS=1
done

write_summary
CALLBACK_SENT=true
if [[ -n "$CALLBACK_URL" && -f "$RUN_DIR/callback.json" ]]; then
  selfqa_post_callback "$CALLBACK_URL" "$CALLBACK_AUTH" "$RUN_DIR/callback.json" || true
fi
if [[ "$FINAL_VERDICT" == "PASS" ]]; then
  exit 0
fi
if [[ "$FINAL_VERDICT" == "BLOCKED" || "$OPEN_FINDINGS" -eq 1 ]]; then
  exit 2
fi
exit 1
