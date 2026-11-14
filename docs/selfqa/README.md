# Self-QA runs

Each sprint writes `docs/selfqa/<run-id>/` (`SUMMARY.md`, `SUMMARY.json`, `VERDICT.json`, logs/, role notes).
Large logs under `logs/` are gitignored.

Start via `./build.sh --selfqa`, Home Base Apps → Self-QA sprint, or MCP `homebase_selfqa`.
Cancel via Apps Cancel / MCP `homebase_cursor_job_cancel`. Spec: `docs/qa/selfqa-qa-spec.md`.
