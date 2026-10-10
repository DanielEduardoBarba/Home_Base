# Verification log

| Timestamp | Command | Scope | Outcome | Error summary | Predates migration? | Evidence type |
|-----------|---------|-------|---------|---------------|---------------------|---------------|
| 2026-10-10 | user cleared `~/.cursor/hooks.json` | IDE workflow | PASS | — | N/A | manual |
| 2026-10-10 | `HOMEBASE_HOME=/tmp/hb-baseline-test .venv/bin/pytest tests/ -q` | Python baseline | PASS (48) | — | no | unit |
| 2026-10-10 | `cd server && bun install` | deps | PASS | earlier sandbox fail | no | build |
| 2026-10-10 | `bun run typecheck` | server | PASS | — | no | unit |
| 2026-10-10 | `bun test` | unit+parity | PASS (7) | — | no | unit/parity |
| 2026-10-10 | `HOMEBASE_SELF_TEST=1 bun run src/entry.ts` | self-test | PASS | — | no | integration |
| 2026-10-10 | `HOMEBASE_PORT=18082 timeout 3 bun run src/entry.ts` | boot | PASS | — | no | integration |
| 2026-10-10 | import node-pty under Bun | PTY | FAIL | uv_version_string panic | no (Bun limit) | integration |
