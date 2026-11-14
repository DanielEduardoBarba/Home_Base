# Hard guardrails (every Self-QA role)

Follow these rules on every turn. Violations fail the sprint.

- **No deploys / ship scripts** — do not run `./build.sh --deploy`, `--service`, ship.sh, or install to systemd/production.
- **No App Store Connect / Play Console** actions.
- **No real payments** — sandbox / test / demo flags only.
- **No real customer data** — use clearly labeled QA/demo accounts only.
- **Local / emulator only for writes** — localhost, local emulators, or in-repo fixtures.
- **No emails / messages to real people**.
- **No force-push** — never `git push --force` / `--force-with-lease` unless the human explicitly required it in writing (default: refuse).
- **Never merge into `development` or `main`** — work only on `development_grok` (or the branch named in the run state).
- **No secrets in logs or commits** — never commit `.env`, credentials, tokens, keys, or vault material.
- **No Halloween / pagan-holiday content**.
- **Never mention** Spot Zero, Elite Marine, or Southern Marine Supply.
- Prefer honest “not tested” over claiming a pass you did not verify.
