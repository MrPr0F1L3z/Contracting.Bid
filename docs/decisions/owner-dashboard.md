# Owner dashboard (2026-11-10)

The owner asked for the dashboard next. This first version replaces the terminal prompts with a browser page and adds a view of saved runs.

## What it does

- `--dashboard` on `bid`, `job` and `closeout` opens a local page where the owner answers approvals. Batches can be approved in full or item by item.
- The page streams the run's events live.
- `pnpm sim dashboard` browses the saved reports in `runs/` after a run.

## Made while building (please review)

1. **Local only, with a token.** The server listens on 127.0.0.1 and needs the token from the printed link on every API call. Nobody else on the network can reach it. *Question:* do you want to reach it from another device, such as your phone? That needs real sign-in and HTTPS, which is a bigger step. **Answered 2026-11-10:** yes, over the public internet. See `dashboard-remote-access.md`.
2. **No time limit on approvals.** A run waits on the page as long as it takes, the same as the terminal. A waiting run spends nothing on models.
3. **The page closes with the run.** When the run ends, so does the server. Use `pnpm sim dashboard` to look back at it. A long-running dashboard that starts runs itself comes with Postgres, when runs outlive a single command.
4. **Reports come from the `runs/` files**, not a database. That changes when the event log moves to Postgres.
5. **Run the CLI on the host**, as with vLLM. A page served from inside a Docker container on 127.0.0.1 is not reachable from the host's browser.
6. **No new dependencies.** The server uses Node's built-in `http` module, and the page is plain HTML and JavaScript inline in the code.
