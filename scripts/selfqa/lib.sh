#!/usr/bin/env bash
# Shared Self-QA helpers (sourced by run.sh and unit tests).
# shellcheck disable=SC2034

SELFQA_REQUIRED_BRANCH="${SELFQA_REQUIRED_BRANCH:-development_grok}"
SELFQA_AGENT_TIMEOUT_SEC="${SELFQA_AGENT_TIMEOUT_SEC:-900}"

selfqa_current_branch() {
  local root="${1:-.}"
  git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || true
}

# Exit 0 if branch ok; prints reason to stderr and returns 1 otherwise.
selfqa_require_branch() {
  local root="${1:-.}"
  local want="${2:-$SELFQA_REQUIRED_BRANCH}"
  local got
  got="$(selfqa_current_branch "$root")"
  if [[ -z "$got" ]]; then
    echo "Error: not a git repo (or no HEAD): $root" >&2
    return 1
  fi
  if [[ "$got" != "$want" ]]; then
    echo "Error: Self-QA requires branch '$want' (current: '$got')" >&2
    return 1
  fi
  return 0
}

# Refuse non-localhost http(s) targets in free text (goal/plan).
# Allows localhost, 127.0.0.1, [::1], and relative/example hosts.
selfqa_localhost_only_text() {
  local text="${1:-}"
  python3 -c '
import re, sys
text = sys.argv[1]
urls = re.findall(r"https?://[^\s\"'"'"'<>)+]+", text)
bad = []
for u in urls:
    if re.match(r"https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(/|$)", u, re.I):
        continue
    bad.append(u)
if bad:
    print("Error: non-localhost target URL(s) not allowed:", file=sys.stderr)
    for u in bad:
        print(u, file=sys.stderr)
    raise SystemExit(1)
' "$text"
}

# Parse strict verdict JSON file. Prints PASS|FAIL|BLOCKED or empty.
selfqa_read_verdict_json() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo ""
    return 0
  fi
  python3 - "$path" <<'PY'
import json, sys
p = sys.argv[1]
try:
    o = json.load(open(p, encoding="utf-8"))
except Exception:
    print("")
    raise SystemExit(0)
v = str((o or {}).get("verdict") or "").strip().upper()
if v in ("PASS", "FAIL", "BLOCKED"):
    print(v)
else:
    print("")
PY
}

# Extract finding ids from a cycle report (id: FOO or [FOO] patterns).
selfqa_extract_finding_ids() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    return 0
  fi
  python3 - "$path" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
ids = set()
for m in re.finditer(r"(?im)^\s*(?:[-*]\s*)?(?:id|finding[\s_-]*id)\s*[:=]\s*`?([A-Za-z0-9][A-Za-z0-9._/-]{1,64})`?", text):
    ids.add(m.group(1))
for m in re.finditer(r"\b([A-Z]{2,}-[A-Z0-9]+-\d+)\b", text):
    ids.add(m.group(1))
for i in sorted(ids):
    print(i)
PY
}

# Return 0 if the intersection of two id lists is non-empty (repeat block).
selfqa_repeat_findings() {
  local a="$1" b="$2"
  [[ -z "$a" || -z "$b" ]] && return 1
  python3 - "$a" "$b" <<'PY'
import sys
A = set(x.strip() for x in open(sys.argv[1], encoding="utf-8") if x.strip())
B = set(x.strip() for x in open(sys.argv[2], encoding="utf-8") if x.strip())
common = sorted(A & B)
if not common:
    raise SystemExit(1)
print("\n".join(common))
raise SystemExit(0)
PY
}

# Guardrail patterns (agent logs + optional git name-status dump).
# Prints matching lines; returns 1 if any match (violation).
selfqa_scan_guardrails() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  # shellcheck disable=SC2016
  if grep -nE \
    -e '(^|[;|&[:space:]])(\./)?build\.sh[[:space:]]+--(deploy|service)\b' \
    -e '(^|[;|&[:space:]])ship\.sh\b' \
    -e '\bfirebase[[:space:]]+deploy\b' \
    -e '\beas[[:space:]]+submit\b' \
    -e '\bgit[[:space:]]+merge\b' \
    -e '\bgit[[:space:]]+push[[:space:]]+.*--force(-with-lease)?\b' \
    -e '\bgit[[:space:]]+push[[:space:]]+[^[:space:]]+[[:space:]]+(main|master|development)\b' \
    -e '\bgit[[:space:]]+push[[:space:]]+.*\b(HEAD:)?(main|master|development)\b' \
    -e '\bgit[[:space:]]+branch[[:space:]]+(-d|-D)\b' \
    -e '\bgit[[:space:]]+push[[:space:]]+.*--delete\b' \
    -e 'App Store Connect|appstoreconnect|ASC API' \
    -e '\b(sk_live_|rk_live_|whsec_)[A-Za-z0-9]+' \
    -e '(price|subscription).{0,40}(change|update|set|increase|decrease)' \
    "$file" 2>/dev/null; then
    return 1
  fi
  return 0
}

# Scan git name-status for deletions outside docs/selfqa.
selfqa_scan_deletions() {
  local root="$1"
  local base_ref="${2:-}"
  local out
  if [[ -n "$base_ref" ]]; then
    out="$(git -C "$root" diff --name-status "$base_ref" -- 2>/dev/null || true)"
  else
    out="$(git -C "$root" status --porcelain 2>/dev/null || true)"
  fi
  local bad
  bad="$(printf '%s\n' "$out" | awk '
    $1 ~ /^D/ {
      path=$2
      if (path !~ /^docs\/selfqa\//) print path
    }
    $1 ~ /^ D/ {
      path=$2
      if (path !~ /^docs\/selfqa\//) print path
    }
  ')"
  if [[ -n "$bad" ]]; then
    echo "Error: file deletion outside docs/selfqa/:" >&2
    printf '%s\n' "$bad" >&2
    return 1
  fi
  return 0
}

# Detect Cursor agent CLI. Prefer cursor-agent; verify bare `agent`.
selfqa_detect_agent() {
  if command -v cursor-agent >/dev/null 2>&1; then
    echo "cursor-agent"
    return 0
  fi
  if command -v agent >/dev/null 2>&1; then
    local help
    help="$(agent --help 2>&1 || true)"
    if printf '%s' "$help" | grep -qiE 'cursor|Agent CLI|print mode|-p.*prompt'; then
      echo "agent"
      return 0
    fi
    echo "Error: 'agent' on PATH is not the Cursor CLI" >&2
    return 1
  fi
  return 1
}

selfqa_run_with_timeout() {
  local secs="${1:-$SELFQA_AGENT_TIMEOUT_SEC}"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=TERM "$secs" "$@"
    return $?
  fi
  "$@"
  return $?
}
