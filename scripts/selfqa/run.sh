#!/usr/bin/env bash
# Self-QA sprint runner — Cursor agent CLI (headless print, model auto).
# Invoked by: ./build.sh --selfqa [options]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROMPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/prompts" && pwd)"
cd "$ROOT"

GOAL=""
GOAL_FILE=""
CYCLES=3
MAX_MINUTES=90
TESTERS=3
DRY_RUN=false

usage() {
  cat <<EOF
Self-QA · cyclic Dev + QA sprint (Cursor agent CLI)

USAGE
  ./build.sh --selfqa [options]
  scripts/selfqa/run.sh [options]

OPTIONS
  --goal "text"          Sprint goal
  --goal-file PATH       Read goal from file
  --cycles N             Max cycles (default 3)
  --max-minutes M        Wall-clock cap (default 90)
  --testers K            QA tester agents (default 3, max 6)
  --dry-run              Print plan only; do not call the agent CLI
  -h, --help             This help

EXIT
  0  PASS
  2  Caps reached with open findings
  1  Error (missing CLI, bad args, agent failure)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --goal) GOAL="${2:-}"; shift 2 ;;
    --goal-file) GOAL_FILE="${2:-}"; shift 2 ;;
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

if [[ -n "$GOAL_FILE" ]]; then
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
  TESTERS=6
fi

detect_agent() {
  if command -v cursor-agent >/dev/null 2>&1; then
    echo "cursor-agent"
    return 0
  fi
  if command -v agent >/dev/null 2>&1; then
    echo "agent"
    return 0
  fi
  return 1
}

AGENT_BIN=""
if ! AGENT_BIN="$(detect_agent)"; then
  cat >&2 <<EOF
Error: Cursor agent CLI not found (tried: cursor-agent, agent).

Install the Cursor CLI, then ensure \`agent\` or \`cursor-agent\` is on PATH.
Docs: https://cursor.com/docs/cli/headless

Example after install:
  agent -p --model auto "hello"
EOF
  exit 1
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_DIR="$ROOT/docs/selfqa/$RUN_ID"
LOG_DIR="$RUN_DIR/logs"
mkdir -p "$LOG_DIR" "$RUN_DIR/testers" "$ROOT/docs/qa"
START_EPOCH="$(date +%s)"
DEADLINE=$((START_EPOCH + MAX_MINUTES * 60))
BRANCH="development_grok"

# Default personas (unique roles; projects may customize via STATE later)
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

printf '%s\n' "$GOAL" >"$RUN_DIR/GOAL.md"
cp -f "$PROMPTS_DIR/guardrails.md" "$RUN_DIR/GUARDRAILS.md"

{
  echo "# Self-QA plan (dry preview)"
  echo
  echo "- runId: \`$RUN_ID\`"
  echo "- branch: \`$BRANCH\`"
  echo "- cycles: $CYCLES · max-minutes: $MAX_MINUTES · testers: $TESTERS"
  echo "- agent: \`$AGENT_BIN\` (model auto, print mode)"
  echo "- goal: $GOAL"
  echo
  echo "## Loop"
  echo "Orchestrator → Developer → QA Manager → $TESTERS tester(s) → Orchestrator … until PASS or caps."
  echo
  echo "## Artifacts"
  echo "- Run dir: \`docs/selfqa/$RUN_ID/\`"
  echo "- Cycle reports: \`docs/qa/selfqa-$RUN_ID-cycleN.md\`"
  echo "- Final: \`docs/selfqa/$RUN_ID/SUMMARY.md\`"
} >"$RUN_DIR/PLAN.md"

echo "==> Self-QA run $RUN_ID"
echo "    goal: $GOAL"
echo "    cycles=$CYCLES max-minutes=$MAX_MINUTES testers=$TESTERS agent=$AGENT_BIN"
echo "    dir: $RUN_DIR"

if [[ "$DRY_RUN" == true ]]; then
  cat "$RUN_DIR/PLAN.md"
  cat >"$RUN_DIR/SUMMARY.md" <<EOF
# Self-QA SUMMARY (dry-run)

- runId: $RUN_ID
- verdict: DRY_RUN
- goal: $GOAL
- cycles planned: $CYCLES
- testers: $TESTERS
- agent: $AGENT_BIN

Dry-run only — no agent invocations.
EOF
  echo "Dry-run complete. Summary: $RUN_DIR/SUMMARY.md"
  exit 0
fi

if [[ ! -f "$ROOT/docs/QA-PROGRESS.md" ]]; then
  cat >"$ROOT/docs/QA-PROGRESS.md" <<EOF
# QA Progress

Self-QA and manual QA notes for this repository.

EOF
fi

run_agent() {
  local role="$1"
  local prompt_file="$2"
  local out_log="$3"
  local extra="${4:-}"
  local guardrails
  guardrails="$(cat "$PROMPTS_DIR/guardrails.md")"
  local role_body
  role_body="$(cat "$prompt_file")"
  local prompt
  prompt="$(cat <<EOF
You are running as Home Base Self-QA role: ${role}.
Working directory: ${ROOT}
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
  set +e
  "$AGENT_BIN" -p --force --model auto --workspace "$ROOT" "$prompt" \
    >"$out_log" 2>"$out_log.err"
  local rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    echo "warn: agent role=$role exited $rc (see $out_log.err)" | tee -a "$LOG_DIR/runner.log"
  fi
  return 0
}

time_up() {
  [[ "$(date +%s)" -ge "$DEADLINE" ]]
}

LAST_QA_REPORT=""
FINAL_VERDICT="FAIL"
OPEN_FINDINGS=1
CYCLE=0

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

  # Developer
  if time_up; then break; fi
  write_state "$CYCLE" "developer"
  run_agent "Developer" "$PROMPTS_DIR/developer.md" \
    "$LOG_DIR/cycle${CYCLE}-developer.log" \
    "Current cycle: $CYCLE. Fix findings then typecheck + tests; commit and push $BRANCH."

  # Seed tester personas
  python3 - <<PY || true
import json
from pathlib import Path
run = Path("$RUN_DIR")
personas = """$(printf '%s\n' "${PERSONAS[@]}")""".strip().splitlines()
k = int("$TESTERS")
rows = []
for i in range(k):
    p = personas[i % len(personas)]
    rows.append({"id": i + 1, "persona": p})
    (run / "testers" / f"tester-{i+1}.md").write_text(
        f"# Tester {i+1}\n\nPersona: {p}\n\nFocus on realistic workflows for this persona.\n"
        f"Write your report to testers/report-{i+1}.md.\n",
        encoding="utf-8",
    )
(run / "TESTERS.json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
PY

  # QA Manager (plans + later collects)
  if time_up; then break; fi
  write_state "$CYCLE" "qa_manager_plan"
  run_agent "QA Manager" "$PROMPTS_DIR/qa_manager.md" \
    "$LOG_DIR/cycle${CYCLE}-qa-manager-plan.log" \
    "Phase: write TEST_PLAN.md and refine tester prompts. Testers will run next. Cycle $CYCLE. run-id $RUN_ID."

  # Testers
  for ((t = 1; t <= TESTERS; t++)); do
    if time_up; then break 2; fi
    write_state "$CYCLE" "tester_$t"
    run_agent "Tester $t" "$PROMPTS_DIR/tester.md" \
      "$LOG_DIR/cycle${CYCLE}-tester${t}.log" \
      "You are tester #$t. Read testers/tester-$t.md. Write testers/report-$t.md."
  done

  # QA Manager collect
  if time_up; then break; fi
  REPORT_PATH="docs/qa/selfqa-${RUN_ID}-cycle${CYCLE}.md"
  LAST_QA_REPORT="$REPORT_PATH"
  write_state "$CYCLE" "qa_manager_collect"
  run_agent "QA Manager" "$PROMPTS_DIR/qa_manager.md" \
    "$LOG_DIR/cycle${CYCLE}-qa-manager.log" \
    "Phase: collect tester reports and write $REPORT_PATH with PASS or FAIL. Update QA_MANAGER.md and docs/QA-PROGRESS.md. Cycle $CYCLE. run-id $RUN_ID."

  if [[ ! -f "$ROOT/$REPORT_PATH" ]]; then
    mkdir -p "$(dirname "$ROOT/$REPORT_PATH")"
    cat >"$ROOT/$REPORT_PATH" <<EOF
# Self-QA cycle $CYCLE ($RUN_ID)

Verdict: FAIL

QA Manager did not write this file. See run logs under docs/selfqa/$RUN_ID/logs/.
EOF
  fi

  VERDICT="FAIL"
  if grep -qiE '^\s*Verdict:\s*PASS\b|\bPASS\b' "$ROOT/$REPORT_PATH" \
    && ! grep -qiE 'Verdict:\s*FAIL' "$ROOT/$REPORT_PATH"; then
    VERDICT="PASS"
  fi
  # Prefer explicit QA_MANAGER.md
  if [[ -f "$RUN_DIR/QA_MANAGER.md" ]]; then
    if grep -qiE 'verdict:\s*PASS|\bPASS\b' "$RUN_DIR/QA_MANAGER.md" \
      && ! grep -qiE 'verdict:\s*FAIL' "$RUN_DIR/QA_MANAGER.md"; then
      VERDICT="PASS"
    elif grep -qiE 'verdict:\s*FAIL' "$RUN_DIR/QA_MANAGER.md"; then
      VERDICT="FAIL"
    fi
  fi

  {
    echo
    echo "## Self-QA $RUN_ID cycle $CYCLE — $VERDICT"
    echo
    echo "- Report: \`$REPORT_PATH\`"
    echo "- Goal: $GOAL"
    date -u +"-% Timestamp: %Y-%m-%dT%H:%M:%SZ"
  } >>"$ROOT/docs/QA-PROGRESS.md"

  write_state "$CYCLE" "done" "$VERDICT"
  if [[ "$VERDICT" == "PASS" ]]; then
    FINAL_VERDICT="PASS"
    OPEN_FINDINGS=0
    break
  fi
  FINAL_VERDICT="FAIL"
  OPEN_FINDINGS=1
done

ELAPSED=$(( ($(date +%s) - START_EPOCH) / 60 ))
cat >"$RUN_DIR/SUMMARY.md" <<EOF
# Self-QA SUMMARY

- runId: $RUN_ID
- verdict: $FINAL_VERDICT
- cyclesCompleted: $CYCLE
- cyclesCap: $CYCLES
- elapsedMinutes: $ELAPSED
- maxMinutes: $MAX_MINUTES
- testers: $TESTERS
- goal: $GOAL
- lastQaReport: ${LAST_QA_REPORT:-none}
- agent: $AGENT_BIN
- branch: $BRANCH

## Notes
$(
  if [[ "$FINAL_VERDICT" == "PASS" ]]; then
    echo "Sprint reached PASS."
  elif time_up || [[ "$CYCLE" -ge "$CYCLES" ]]; then
    echo "Caps reached with open findings (or incomplete PASS)."
  else
    echo "Stopped with open findings."
  fi
)
EOF

echo "==> SUMMARY: $RUN_DIR/SUMMARY.md (verdict=$FINAL_VERDICT)"
if [[ "$FINAL_VERDICT" == "PASS" ]]; then
  exit 0
fi
if [[ "$OPEN_FINDINGS" -eq 1 ]]; then
  exit 2
fi
exit 1
