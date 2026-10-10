# Overnight report — Python → Bun migration

**Date:** 2026-10-10  
**VERSION:** 1.4.23  
**Cutover safe?** **No** — View capture and full PTY/Cursor streaming incomplete; Bun is default for `--run`/`--deploy` but production View/Chat agent runs need follow-up.

## 1. Completed and verified

- Migration docs + always-on rule (`.cursor/rules/backend-migration.mdc`)
- Python baseline: `48 passed` (`HOMEBASE_HOME=/tmp/hb-baseline-test .venv/bin/pytest tests/ -q`)
- `server-ts/` Bun + Hono + Zod + strict TypeScript scaffold
- Auth module (scrypt params, JWT/`ae`, lockout schedule) + share localhost Origin gate
- REST coverage: health, version, auth, share, projects, files, sessions, notifications, trace, journal, sudo, system, view status, hook-approve
- WS routes wired: `/ws/pty`, `/ws/session/:id`, `/ws/view`, `/ws/cursor`
- `bun run typecheck` — PASS
- `bun test` — **7 pass / 0 fail**
- `HOMEBASE_SELF_TEST=1 bun run src/entry.ts` — PASS
- Dev boot on ephemeral port — PASS
- `build.sh --run` defaults to Bun; `--python` for uvicorn
- `build.sh --bin`/`--deploy` default Bun compile; `--python` → Nuitka

## 2. Implemented but unverified / incomplete

- Shell sessions: **pipe fallback** (not real PTY) — R-004
- View: status + WS hello only; **no X11 capture/input** — R-002
- Cursor: workspace persistence + models stub; **agent streaming not ported**
- Actions/process/ports: basic implementation; not parity-tested vs Python
- Bun `bun build --compile` deploy path not exercised end-to-end on this host overnight
- Hook-approve fail-open under ask when no UI (R-003) — behavior change vs Python block-until-approve

## 3. Missing or blocked

| ID | Item |
|----|------|
| R-002 | View X11 worker (mss/XTest) |
| R-004 | Real PTY under Bun |
| P-CURSOR | Full `@cursor/sdk` run/stream/approvals/sudo |
| R-001 | Prod packaging polish / self-test under systemd for Bun |

## 4. Review-required (see REVIEW_REQUIRED.md)

- **R-001** packaging shape  
- **R-002** View worker  
- **R-003** IDE hooks UX (user cleared hooks.json to unblock IDE)  
- **R-004** node-pty / Bun  

## 5. Commands and outcomes

| Command | Outcome |
|---------|---------|
| `HOMEBASE_HOME=/tmp/hb-baseline-test .venv/bin/pytest tests/ -q` | 48 passed |
| `cd server-ts && bun run typecheck` | PASS |
| `cd server-ts && bun test` | 7 passed |
| `HOMEBASE_SELF_TEST=1 bun run src/entry.ts` | ok version=1.4.23 |
| `HOMEBASE_PORT=18082 timeout 3 bun run src/entry.ts` | listens |
| Early `node-pty` load | **CRASH** Bun (documented R-004) |

## 6. Baseline vs regressions

- Python suite green; no intentional Python deletions
- Bun health adds `runtime: "bun"` field (additive)
- Shell/View/Cursor not at Python parity — do not treat as regressions of Python; gaps in Bun port

## 7. Remaining Python runtime dependencies

- Full rollback path: `server/`, Nuitka `--python`
- Optional: View worker still Python-only until R-002
- `build.sh --setup` still creates `.venv` for rollback/JWT seed

## 8. Startup commands (current)

| Mode | Command |
|------|---------|
| **Default dev** | `./build.sh --run` → Bun `:8081` + Vite `:3081` |
| Python dev | `./build.sh --run --python` |
| Default deploy | `./build.sh --deploy` (Bun compile) |
| Python deploy | `./build.sh --deploy --python` |
| Bun direct | `cd server-ts && HOMEBASE_PORT=8081 bun run dev` |

## 9. Cutover safe?

**No** for claiming full feature parity. **Yes** for using Bun as the default *dev* entry once you accept View/PTY/Cursor gaps. Keep Python deploy until R-002/R-004/Cursor verified.

## 10. Rollback

```bash
./build.sh --run --python
./build.sh --deploy --python   # restore Nuitka binary + .bak wrapper behavior
```

Python tree `server/` untouched.

## 11. Highest-priority next actions

1. Bun-native or Node-sidecar **PTY** (close R-004)  
2. Port **View worker** without Python (R-002)  
3. Port **Cursor SDK streaming** + homebase_* tools  
4. Exercise `./build.sh --bin` + `--deploy` Bun on a spare machine; fix wrapper `HOMEBASE_SELF_TEST`  
5. Revisit IDE hooks: shorter timeout / fail-open / don’t brick Cursor IDE (R-003)  
