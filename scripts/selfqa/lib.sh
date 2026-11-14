#!/usr/bin/env bash
# Shared Self-QA helpers (sourced by run.sh and unit tests).
# Runtime enforcement (hooks/shims/blank deploy env) is primary; text scan is a
# second layer that normalizes commands and skips prose negations.
# shellcheck disable=SC2034

SELFQA_REQUIRED_BRANCH="${SELFQA_REQUIRED_BRANCH:-development_grok}"
SELFQA_AGENT_TIMEOUT_SEC="${SELFQA_AGENT_TIMEOUT_SEC:-900}"

selfqa_die() {
  echo "Error: $*" >&2
  if declare -F selfqa_on_die >/dev/null 2>&1; then
    selfqa_on_die "$*" || true
  fi
  exit 1
}

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
  if [[ -z "$got" || "$got" == "HEAD" ]]; then
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

# Extract OPEN finding ids only. Pass/fixed/closed/verified/resolved do not count.
selfqa_extract_finding_ids() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    return 0
  fi
  python3 - "$path" <<'PY'
import re, sys

text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
closed_re = re.compile(
    r"(?i)\b(pass(?:ed)?|fixed|closed|verified|resolved|done|wontfix|won'?t\s*fix|n/?a)\b"
)
open_re = re.compile(
    r"(?i)\b(fail(?:ed)?|open|blocked|repro|high|medium|low|critical|bug|regression)\b"
)
id_re = re.compile(r"\b([A-Z]{2,}-[A-Z0-9]+-\d+)\b")
line_id_re = re.compile(
    r"(?im)^\s*(?:[-*]\s*)?(?:id|finding[\s_-]*id)\s*[:=]\s*`?([A-Za-z0-9][A-Za-z0-9._/-]{1,64})`?"
)

def status_near(block: str) -> str:
    m = re.search(r"(?im)^\s*(?:[-*]\s*)?(?:status|result|verdict)\s*[:=]\s*(.+)$", block)
    if m:
        return m.group(1).strip()
    # Same-line markers like "ID: HB-R1-01 — Pass" / "**Pass**"
    return block[:240]

def is_closed(block: str) -> bool:
    st = status_near(block)
    if closed_re.search(st) and not open_re.search(st):
        return True
    # Explicit markdown table cells / badges near the id
    if re.search(r"(?i)\b(?:status|result)\b.{0,40}\b(?:pass|fixed|closed|verified)\b", block):
        return True
    if re.search(r"(?i)\bas\s+(?:pass|fixed|closed|verified)\b", block):
        return True
    return False

open_ids = set()
# Section-oriented: split on headings / blank-line gaps that introduce an ID.
chunks = re.split(r"(?m)(?=^#{1,6}\s|\n(?=[-*]\s*(?:\*\*)?(?:id|finding)))", text)
if len(chunks) <= 1:
    chunks = re.split(r"\n{2,}", text)

for chunk in chunks:
    ids = set(id_re.findall(chunk))
    for m in line_id_re.finditer(chunk):
        ids.add(m.group(1))
    if not ids:
        continue
    if is_closed(chunk):
        continue
    # If the chunk only restates a closed id in a Pass table row, skip.
    # Default: treat as open when status is missing or open-flavored.
    for i in ids:
        # Per-id line scan
        for line in chunk.splitlines():
            if i not in line:
                continue
            if closed_re.search(line) and not open_re.search(line):
                break
            open_ids.add(i)
            break
        else:
            if not is_closed(chunk):
                open_ids.add(i)

for i in sorted(open_ids):
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

# Guardrail scan: normalize commands (split ; && || | $() , strip env/cd, basename)
# then match forbidden deploy/ship/push/price forms. Skips prose negations.
# Optional 2nd arg: repo root for bare `git push` upstream checks.
# Prints matching lines; returns 1 if any match (violation).
selfqa_scan_guardrails() {
  local file="$1"
  local repo_root="${2:-.}"
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  SELFQA_SCAN_REPO="$repo_root" python3 - "$file" <<'PY'
import os, re, shlex, subprocess, sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8", errors="replace")
repo = os.environ.get("SELFQA_SCAN_REPO") or "."
branch_want = os.environ.get("SELFQA_REQUIRED_BRANCH") or "development_grok"

NEG = re.compile(
    r"(?i)\b("
    r"do\s+not|don'?t|does\s+not|did\s+not|"
    r"will\s+not|won'?t|would\s+not|"
    r"must\s+not|should\s+not|shall\s+not|"
    r"cannot|can'?t|could\s+not|"
    r"never|avoid|forbid(?:s|den)?|refusing|refuse\s+to|"
    r"instead\s+of|without\s+(?:running|calling|using|executing)|"
    r"not\s+(?:run|running|execute|call|invoke|use)"
    r")\b.{0,48}$"
)

PRICE = re.compile(
    r"(?i)\b("
    r"(?:change|update|increase|raise|lower|drop|set)\s+(?:the\s+)?"
    r"(?:subscription\s+)?(?:price|pricing)\b|"
    r"(?:subscription\s+)?(?:price|pricing)\s+(?:change|update|increase|raise|lower|drop)\b|"
    r"set\s+(?:the\s+)?price\s+to\b|"
    r"update\s+pricing\b|"
    r"new\s+price\s+tier\b|"
    r"change\s+the\s+subscription\s+price\b|"
    r"change\s+the\s+price\s+of\b|"
    r"increase\s+the\s+price\b|"
    r"raise\s+the\s+price\b|"
    r"lower\s+the\s+price\b|"
    r"drop\s+the\s+price\b"
    r")"
)

ASC = re.compile(
    r"(?i)App Store Connect|appstoreconnect|ASC API|Google Play Console|transporter\s+upload"
)
LIVEKEY = re.compile(r"\b(?:sk_live_|rk_live_|whsec_)[A-Za-z0-9]+")

DEPLOY_SCRIPTS = {
    "ship.sh", "ship-expo.sh", "build-expo.sh",
    "deploy.sh", "deploy-api.sh", "deploy-web.sh",
}
SHELLS = {"bash", "sh", "zsh", "dash", "env", "command", "time", "nice", "nohup"}

def is_negation(prefix: str) -> bool:
    return bool(NEG.search(prefix[-80:] if len(prefix) > 80 else prefix))

def split_pipeline(s: str):
    # Split on ; && || | and bare newlines, but keep simple.
    parts = re.split(r"(?:&&|\|\||;|\n|\|(?!\|))", s)
    out = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        # Unwrap subshell / grouping: (./ship.sh) or { ./ship.sh; }
        while len(p) >= 2 and p[0] in "({" and p[-1] in ")}":
            p = p[1:-1].strip()
        # Expand $(cmd) / `cmd` as nested candidates
        for m in re.finditer(r"\$\(([^)]*)\)|`([^`]*)`", p):
            inner = (m.group(1) or m.group(2) or "").strip()
            if inner:
                out.extend(split_pipeline(inner))
        out.append(p)
    return out

def strip_env_and_cd(tokens):
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t):
            i += 1
            continue
        if t == "cd" and i + 1 < len(tokens):
            i += 2
            # optional && already split away
            continue
        break
    return tokens[i:]

def tokenize(cmd: str):
    # Soft tokenize: prefer shlex, fall back to whitespace
    try:
        toks = shlex.split(cmd, posix=True)
    except ValueError:
        toks = cmd.split()
    return strip_env_and_cd(toks)

def basename_tok(t: str) -> str:
    t = t.strip().strip("\"'")
    if "/" in t:
        t = t.rsplit("/", 1)[-1]
    return t

def git_upstream_ok() -> bool:
    try:
        br = subprocess.check_output(
            ["git", "-C", repo, "rev-parse", "--abbrev-ref", "HEAD"],
            text=True, stderr=subprocess.DEVNULL,
        ).strip()
        if br != branch_want:
            return False
        up = subprocess.check_output(
            ["git", "-C", repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            text=True, stderr=subprocess.DEVNULL,
        ).strip()
        return up == f"origin/{branch_want}"
    except Exception:
        return False

def analyze_git_push(tokens) -> str | None:
    # tokens start at 'git'
    args = tokens[1:]
    if not args or args[0] != "push":
        return None
    rest = args[1:]
    joined = " ".join(rest)
    # Force / delete / mirror / all
    for i, a in enumerate(rest):
        if a in ("-f", "--force", "--force-with-lease", "--delete", "-d", "--all", "--mirror"):
            return f"forbidden git push flag: {a}"
        if a.startswith("--force"):
            return f"forbidden git push flag: {a}"
        if a == "--" and i + 1 < len(rest):
            # refspecs after --
            pass
    # Bare `git push` (no remote/ref): only OK if upstream is origin/development_grok
    # Treat options-only as bare-ish.
    positionals = [a for a in rest if not a.startswith("-")]
    if not positionals:
        if git_upstream_ok():
            return None
        return "bare git push without origin/development_grok upstream"
    remote = positionals[0]
    refs = positionals[1:]
    # git push <refspec> (no remote) is unusual; still inspect
    if remote in ("origin",) or remote.startswith("http") or ":" not in remote:
        pass
    # Block refspecs that target non-development_grok
    candidates = refs if refs else ([] if remote == "origin" and not refs else [remote] if ":" in remote else refs)
    if remote != "origin" and not remote.startswith("http") and ":" in remote:
        candidates = [remote] + refs
    elif remote == "origin":
        candidates = refs
    else:
        # remote might actually be a refspec
        if ":" in remote or remote in ("main", "master", "development", branch_want):
            candidates = [remote] + refs
        else:
            candidates = refs

    if not candidates:
        # `git push origin` with no ref → current branch upstream on that remote
        if remote == "origin" and git_upstream_ok():
            return None
        return "git push origin without explicit development_grok ref"

    for ref in candidates:
        local, _, remote_ref = ref.partition(":")
        target = remote_ref or local
        target = target.replace("refs/heads/", "")
        if target in ("HEAD",):
            return "git push refspec uses HEAD destination"
        if target != branch_want:
            return f"git push to non-{branch_want} ref: {ref}"
    return None

def analyze_tokens(tokens) -> str | None:
    if not tokens:
        return None
    # Unwrap env/shell wrappers; re-strip KEY=VAL after each hop (env FOO=1 bash …)
    while tokens:
        tokens = strip_env_and_cd(tokens)
        if not tokens:
            return None
        if basename_tok(tokens[0]) not in SHELLS:
            break
        # bash ./ship.sh  /  sh -c '...'
        if len(tokens) >= 2 and tokens[1] in ("-c", "-lc"):
            # Can't safely parse -c string here beyond outer scan
            break
        tokens = tokens[1:]
        # bash/sh may take script path as next arg
        if tokens and basename_tok(tokens[0]).endswith(".sh"):
            tokens = strip_env_and_cd(tokens)
            break
    if not tokens:
        return None
    tokens = strip_env_and_cd(tokens)
    if not tokens:
        return None
    b0 = basename_tok(tokens[0])
    low = [t.lower() for t in tokens]

    if b0 in DEPLOY_SCRIPTS:
        return f"deploy/ship script: {b0}"
    if b0 == "build.sh":
        args = tokens[1:]
        for a in args:
            if a in ("--deploy", "--deploy-api", "--deploy-web", "--ship", "--service", "--shipexpo"):
                return f"build.sh deploy mode: {a}"
            if a in ("d", "a", "s", "m"):
                return f"build.sh deploy shorthand: {a}"
    if b0 == "pnpm":
        # pnpm deploy* / pnpm run deploy*
        if len(tokens) >= 2 and tokens[1].startswith("deploy"):
            return f"pnpm {tokens[1]}"
        if len(tokens) >= 3 and tokens[1] == "run" and tokens[2].startswith("deploy"):
            return f"pnpm run {tokens[2]}"
    if b0 == "firebase" and "deploy" in low:
        return "firebase deploy"
    if b0 == "eas":
        if "submit" in low or "deploy" in low:
            return "eas submit/deploy"
        if "build" in low and "--profile" in low:
            try:
                i = low.index("--profile")
                if i + 1 < len(low) and low[i + 1] == "production":
                    return "eas build --profile production"
            except ValueError:
                pass
    if b0 == "gcloud" and "deploy" in low:
        return "gcloud deploy"
    if b0 == "git":
        if len(tokens) >= 2 and tokens[1] == "merge":
            return "git merge"
        if len(tokens) >= 2 and tokens[1] == "push":
            return analyze_git_push(tokens)
        if len(tokens) >= 3 and tokens[1] == "branch" and tokens[2] in ("-d", "-D", "--delete"):
            return "git branch delete"
        if len(tokens) >= 2 and tokens[1] == "rm":
            return "git rm"
    return None

hits = []
# Line-oriented with prefix negation; also scan whole text for price/ASC/keys
for m in PRICE.finditer(text):
    if is_negation(text[: m.start()]):
        continue
    hits.append(f"price/subscription change: {m.group(0)!r}")
for m in ASC.finditer(text):
    if is_negation(text[: m.start()]):
        continue
    hits.append(f"store console: {m.group(0)!r}")
for m in LIVEKEY.finditer(text):
    hits.append(f"live payment key: {m.group(0)[:12]}…")

SCRIPT_INLINE = re.compile(
    r"(?i)(?:^|[\s;|&`$(\"'])("
    r"(?:\./|[\w./+-]+/)?"
    r"(?:ship(?:-expo)?|build-expo|deploy(?:-api|-web)?|build)\.sh"
    r"(?:[\t ]+[^\n;|&]*)?"
    r")"
)

# Command extraction from lines that look executable
for line in text.splitlines():
    raw = line.rstrip()
    if not raw.strip():
        continue
    # Strip common log prefixes
    body = re.sub(r"^(?:\s*\[.*?\]\s*|\s*\d+:\s*|\s*[\$#>]\s*)", "", raw)
    candidates = list(split_pipeline(body))
    # Also lift mid-line script invocations: "running ./build.sh --deploy now"
    for m in SCRIPT_INLINE.finditer(body):
        candidates.append(m.group(1).strip())
    for chunk in candidates:
        # Find chunk start in line for negation window
        idx = body.find(chunk[: min(12, len(chunk))]) if chunk else -1
        pre = body[: idx if idx >= 0 else 0]
        if is_negation(pre) or is_negation(raw[: max(0, raw.find(chunk[:8]) if chunk else 0)]):
            continue
        tokens = tokenize(chunk)
        if not tokens:
            continue
        # Also handle `bash ./ship.sh` after unwrap in analyze
        reason = analyze_tokens(tokens)
        if reason:
            hits.append(f"{reason} :: {chunk.strip()}")

# Deduplicate while preserving order
seen = set()
out = []
for h in hits:
    if h in seen:
        continue
    seen.add(h)
    out.append(h)

if out:
    for h in out:
        print(h)
    raise SystemExit(1)
raise SystemExit(0)
PY
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

# True when `bin --version` looks like the Cursor Agent CLI (never run login).
selfqa_is_cursor_agent_bin() {
  local bin="$1"
  [[ -n "$bin" ]] || return 1
  command -v "$bin" >/dev/null 2>&1 || [[ -x "$bin" ]] || return 1
  local ver
  ver="$("$bin" --version 2>&1 || true)"
  if printf '%s' "$ver" | grep -qE '[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[A-Za-z0-9]+'; then
    return 0
  fi
  if printf '%s' "$ver" | grep -qiE 'cursor[[:space:]]+(agent|cli)|agent[[:space:]]+cli'; then
    return 0
  fi
  local help
  help="$("$bin" --help 2>&1 || true)"
  if printf '%s' "$help" | grep -qiE 'Cursor Agent|Agent CLI|cursor\.com|--print'; then
    return 0
  fi
  return 1
}

selfqa_detect_agent() {
  if [[ "${SELFQA_IGNORE_LOCAL_BIN:-}" != "1" && -n "${HOME:-}" && -d "$HOME/.local/bin" ]]; then
    case ":${PATH:-}:" in
      *":$HOME/.local/bin:"*) ;;
      *) export PATH="$HOME/.local/bin:${PATH:-/usr/bin:/bin}" ;;
    esac
  fi
  if command -v cursor-agent >/dev/null 2>&1 && selfqa_is_cursor_agent_bin cursor-agent; then
    echo "cursor-agent"
    return 0
  fi
  if command -v agent >/dev/null 2>&1; then
    if selfqa_is_cursor_agent_bin agent; then
      echo "agent"
      return 0
    fi
    echo "Error: 'agent' on PATH is not the Cursor CLI (agent --version check failed)." >&2
    echo "Install: curl https://cursor.com/install -fsS | bash" >&2
    echo "Then verify: agent --version  (Dan signs in with agent login himself — never auto-login)." >&2
    return 1
  fi
  return 1
}

selfqa_agent_install_hint() {
  cat <<'EOF'
Install the Cursor Agent CLI, then verify it is Cursor's binary:
  curl https://cursor.com/install -fsS | bash
  export PATH="$HOME/.local/bin:$PATH"
  agent --version
Do NOT run agent login from automation — the operator signs in interactively.
Docs: https://cursor.com/docs/cli/installation
EOF
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

# --- Runtime enforcement (where commands run) ---------------------------------

# Install a run-scoped pre-push hook via core.hooksPath.
# Args: hooks_dir  state_file  [allowed_branch=development_grok]
selfqa_install_pre_push_hook() {
  local hooks_dir="${1:?}"
  local state_file="${2:?}"
  local branch="${3:-development_grok}"
  mkdir -p "$hooks_dir"
  cat >"$hooks_dir/pre-push" <<EOF
#!/usr/bin/env bash
# Self-QA run-scoped pre-push: only ${branch} -> origin/${branch}; no force/delete.
set -euo pipefail
ALLOWED_BRANCH="${branch}"
ALLOWED_REF="refs/heads/\${ALLOWED_BRANCH}"
while read -r local_ref local_sha remote_ref remote_sha; do
  [[ -z "\${local_ref:-}" && -z "\${remote_ref:-}" ]] && continue
  if [[ "\$local_sha" =~ ^0+\$ ]]; then
    echo "error: Self-QA pre-push refuses branch/ref deletion" >&2
    exit 1
  fi
  if [[ "\$local_ref" != "\$ALLOWED_REF" ]]; then
    echo "error: Self-QA pre-push refuses local ref \$local_ref (only \$ALLOWED_REF)" >&2
    exit 1
  fi
  if [[ "\$remote_ref" != "\$ALLOWED_REF" ]]; then
    echo "error: Self-QA pre-push refuses remote ref \$remote_ref (only \$ALLOWED_REF)" >&2
    exit 1
  fi
  if [[ ! "\$remote_sha" =~ ^0+\$ ]]; then
    if ! git merge-base --is-ancestor "\$remote_sha" "\$local_sha" 2>/dev/null; then
      echo "error: Self-QA pre-push refuses non-fast-forward / force push" >&2
      exit 1
    fi
  fi
done
exit 0
EOF
  chmod +x "$hooks_dir/pre-push"

  local prev=""
  prev="$(git config --local --get core.hooksPath 2>/dev/null || true)"
  local had=0
  if git config --local --get core.hooksPath >/dev/null 2>&1; then
    had=1
  fi
  {
    echo "had_hooks_path=$had"
    echo "prev_hooks_path=$prev"
    echo "hooks_dir=$hooks_dir"
  } >"$state_file"
  git config --local core.hooksPath "$hooks_dir"
  return 0
}

selfqa_restore_hooks_path() {
  local state_file="${1:?}"
  [[ -f "$state_file" ]] || return 0
  local had="0"
  local prev=""
  had="$(grep -E '^had_hooks_path=' "$state_file" | head -1 | cut -d= -f2- || true)"
  prev="$(grep -E '^prev_hooks_path=' "$state_file" | head -1 | cut -d= -f2- || true)"
  if [[ "$had" == "1" && -n "$prev" ]]; then
    git config --local core.hooksPath "$prev" || true
  else
    git config --local --unset core.hooksPath 2>/dev/null || true
  fi
  return 0
}

# Create PATH shims that refuse deploy/ship entry points when SELFQA_RUN is set.
# Args: shim_dir  repo_root
selfqa_create_path_shims() {
  local shim_dir="${1:?}"
  local repo_root="${2:?}"
  mkdir -p "$shim_dir"

  local refuse_simple
  refuse_simple="$(cat <<'EOS'
#!/usr/bin/env bash
if [[ "${SELFQA_RUN:-}" == "1" ]]; then
  echo "error: Self-QA refuses $(basename "$0") while SELFQA_RUN=1" >&2
  exit 1
fi
echo "error: Self-QA shim $(basename "$0") invoked without SELFQA_RUN" >&2
exit 1
EOS
)"
  local name
  for name in ship.sh deploy.sh deploy-api.sh deploy-web.sh ship-expo.sh build-expo.sh; do
    printf '%s\n' "$refuse_simple" >"$shim_dir/$name"
    chmod +x "$shim_dir/$name"
  done

  cat >"$shim_dir/build.sh" <<EOF
#!/usr/bin/env bash
# Self-QA PATH shim: allow non-deploy build.sh modes; refuse d/a/s/m and --deploy*/--ship.
set -euo pipefail
REAL_BUILD=${repo_root@Q}/build.sh
if [[ "\${SELFQA_RUN:-}" == "1" ]]; then
  for a in "\$@"; do
    case "\$a" in
      d|a|s|m|--deploy|--deploy-api|--deploy-web|--ship|--service|--shipexpo)
        echo "error: Self-QA refuses ./build.sh deploy mode '\$a' while SELFQA_RUN=1" >&2
        exit 1
        ;;
    esac
  done
fi
exec bash "\$REAL_BUILD" "\$@"
EOF
  chmod +x "$shim_dir/build.sh"

  cat >"$shim_dir/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${SELFQA_RUN:-}" == "1" ]]; then
  if [[ "${1:-}" =~ ^deploy ]]; then
    echo "error: Self-QA refuses 'pnpm $1' while SELFQA_RUN=1" >&2
    exit 1
  fi
  if [[ "${1:-}" == "run" && "${2:-}" =~ ^deploy ]]; then
    echo "error: Self-QA refuses 'pnpm run $2' while SELFQA_RUN=1" >&2
    exit 1
  fi
fi
SHIM_DIR="$(cd "$(dirname "$0")" && pwd)"
NEW_PATH=""
IFS=':' read -ra _parts <<<"${PATH:-}"
for p in "${_parts[@]}"; do
  [[ "$p" == "$SHIM_DIR" ]] && continue
  if [[ -z "$NEW_PATH" ]]; then NEW_PATH="$p"; else NEW_PATH="$NEW_PATH:$p"; fi
done
export PATH="$NEW_PATH"
exec pnpm "$@"
EOF
  chmod +x "$shim_dir/pnpm"

  for name in firebase eas gcloud xcrun; do
    cat >"$shim_dir/$name" <<EOF
#!/usr/bin/env bash
set -euo pipefail
CMD=$(printf '%q' "$name")
if [[ "\${SELFQA_RUN:-}" == "1" ]]; then
  joined="\$*"
  case "\$CMD" in
    firebase)
      if [[ "\$joined" =~ (^|[[:space:]])deploy([[:space:]]|\$) ]]; then
        echo "error: Self-QA refuses 'firebase deploy' while SELFQA_RUN=1" >&2
        exit 1
      fi
      ;;
    eas)
      if [[ "\$joined" =~ (^|[[:space:]])(submit|deploy)([[:space:]]|\$) ]]; then
        echo "error: Self-QA refuses 'eas submit/deploy' while SELFQA_RUN=1" >&2
        exit 1
      fi
      if [[ "\$joined" =~ (^|[[:space:]])build([[:space:]]|\$) ]] && [[ "\$joined" =~ --profile[[:space:]]+production ]]; then
        echo "error: Self-QA refuses 'eas build --profile production' while SELFQA_RUN=1" >&2
        exit 1
      fi
      ;;
    gcloud)
      if [[ "\$joined" =~ (^|[[:space:]])deploy([[:space:]]|\$) ]]; then
        echo "error: Self-QA refuses 'gcloud … deploy' while SELFQA_RUN=1" >&2
        exit 1
      fi
      ;;
    xcrun)
      if [[ "\$joined" =~ altool ]]; then
        echo "error: Self-QA refuses 'xcrun altool' while SELFQA_RUN=1" >&2
        exit 1
      fi
      ;;
  esac
fi
SHIM_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
NEW_PATH=""
IFS=':' read -ra _parts <<<"\${PATH:-}"
for p in "\${_parts[@]}"; do
  [[ "\$p" == "\$SHIM_DIR" ]] && continue
  if [[ -z "\$NEW_PATH" ]]; then NEW_PATH="\$p"; else NEW_PATH="\$NEW_PATH:\$p"; fi
done
export PATH="\$NEW_PATH"
if command -v "\$CMD" >/dev/null 2>&1; then
  exec "\$CMD" "\$@"
fi
echo "error: \$CMD not found on PATH (Self-QA shim)" >&2
exit 127
EOF
    chmod +x "$shim_dir/$name"
  done

  # Absolute-path / cwd invocations: wrap common names into shim_dir early PATH.
  # Also place a refuse wrapper named altool for `xcrun altool` style PATH hits.
  printf '%s\n' "$refuse_simple" >"$shim_dir/altool"
  chmod +x "$shim_dir/altool"
}

selfqa_prepare_agent_home() {
  local agent_home="${1:?}"
  local real_home="${2:-$HOME}"
  mkdir -p "$agent_home/.config" "$agent_home/.local/share" "$agent_home/.local/bin"
  local d
  for d in .cursor .config/cursor .config/cursor-agent .local/share/cursor-agent; do
    if [[ -e "$real_home/$d" && ! -e "$agent_home/$d" ]]; then
      mkdir -p "$(dirname "$agent_home/$d")"
      ln -s "$real_home/$d" "$agent_home/$d" || true
    fi
  done
  mkdir -p \
    "$agent_home/.config/gcloud" \
    "$agent_home/.config/configstore" \
    "$agent_home/.expo" \
    "$agent_home/empty-gcloud"
  : >"$agent_home/.config/gcloud/.selfqa-empty"
  return 0
}

selfqa_agent_env_exports() {
  local shim_dir="${1:?}"
  local agent_home="${2:?}"
  cat <<EOF
SELFQA_RUN=1
HOME=$agent_home
XDG_CONFIG_HOME=$agent_home/.config
CLOUDSDK_CONFIG=$agent_home/empty-gcloud
FIREBASE_TOKEN=
GOOGLE_APPLICATION_CREDENTIALS=
GCLOUD_ACCESS_TOKEN=
CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=
EXPO_TOKEN=
EAS_ACCESS_TOKEN=
EXPO_APPLE_PASSWORD=
APPLE_ID=
APPLE_APP_SPECIFIC_PASSWORD=
APP_STORE_CONNECT_API_KEY_PATH=
FIREBASE_CLI_EXPERIMENTS=
PATH=$shim_dir:\${PATH}
EOF
}
