# Feature parity inventory

States: Implementation = TODO / IN_PROGRESS / DONE / BLOCKED · Verification = TODO / PASS / FAIL / INFERRED / BLOCKED

| ID | Feature | Python | Frontend | Target | Impl | Verify |
|----|---------|--------|----------|--------|------|--------|
| P-HEALTH | GET /api/health | main.py | api.ts | server | DONE | PASS |
| P-VERSION | GET /api/version | version.py | api.ts | server | DONE | PASS |
| P-AUTH-STATUS | GET /api/auth/status | auth.py | Login | auth.ts | DONE | INFERRED |
| P-LOGIN | POST /api/login | auth.py | Login | auth.ts | DONE | INFERRED |
| P-BOOTSTRAP | POST /api/auth/bootstrap | auth.py | Login | auth.ts | DONE | INFERRED |
| P-PASSWORD | POST /api/auth/password | auth.py | Sharing | auth.ts | DONE | INFERRED |
| P-LOCKOUT | lockout | auth.py | — | auth.ts | DONE | INFERRED |
| P-SHARE | share/* | share.py | Sharing | share.ts | DONE | PASS (localhost gate) |
| P-PROJECTS | projects/* | main/process | Apps | process.ts | DONE | INFERRED |
| P-FILES | fs/* | files.py | FilesTab | files.ts | DONE | INFERRED |
| P-SESSIONS | sessions/* | pty_manager | ShellTab | pty.ts | DONE | INFERRED |
| P-WS-PTY | /ws/pty,session | pty_manager | Terminal | pty.ts | BLOCKED | pipe only R-004 |
| P-NOTIF | notifications/* | notifications.py | Notify | notifications.ts | DONE | INFERRED |
| P-TRACE | trace/* | trace_log | LogsTab | trace.ts | DONE | INFERRED |
| P-SYSTEM | system/* | system_ctl | Settings | system.ts | DONE | INFERRED |
| P-SUDO | sudo/* | sudo_auth | ChatPanel | sudo.ts | DONE | INFERRED |
| P-CURSOR | cursor REST+WS | cursor_bridge | ChatPanel | cursor.ts | BLOCKED | workspace only |
| P-VIEW | view status+WS | view.py | ViewTab | view.ts | BLOCKED | R-002 |
| P-STATIC | SPA assets | static_compress | — | static.ts | DONE | INFERRED |
| P-HOOK | hook-approve | approvals.py | hooks | approvals.ts | DONE | INFERRED (fail-open ask) |
