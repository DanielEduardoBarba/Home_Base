# Migration TASKS

| ID | Objective | Deps | State | Acceptance |
|----|-----------|------|-------|------------|
| T-DOCS | Durable migration docs + rule | — | DONE | docs + rule |
| T-BASELINE | Isolated Python pytest | T-DOCS | DONE | 48 passed |
| T-SCAFFOLD | server-ts Bun/Hono/Zod | T-DOCS | DONE | typecheck pass |
| T-AUTH | Auth/JWT/scrypt/lockout | T-SCAFFOLD | DONE | unit tests + code |
| T-SHARE | Share localhost gate | T-AUTH | DONE | unit tests |
| T-HEALTH | health/version | T-SCAFFOLD | DONE | parity tests |
| T-PROJECTS | projects/action/stop | T-AUTH | DONE | impl; limited verify |
| T-FILES | fs list/read/write | T-AUTH | DONE | impl; limited verify |
| T-NOTIF | notifications | T-AUTH | DONE | impl |
| T-TRACE | trace/journal/client | T-AUTH | DONE | impl |
| T-STATIC | SPA + br/gz | T-SCAFFOLD | DONE | impl |
| T-PTY | PTY WS | T-AUTH | BLOCKED | pipe fallback only (R-004) |
| T-PROCESS | actions/ports | T-PTY | DONE | basic; needs parity tests |
| T-SUDO | sudo askpass | T-AUTH | DONE | impl |
| T-SYSTEM | systemctl | T-AUTH | DONE | impl |
| T-CURSOR | chat WS + SDK | T-AUTH | BLOCKED | workspace only |
| T-VIEW | view capture | T-AUTH | BLOCKED | R-002 |
| T-WIRE | Bun default build.sh | T-SCAFFOLD | DONE | --run/--deploy Bun; --python |
| T-REPORT | OVERNIGHT_REPORT | * | DONE | written |
