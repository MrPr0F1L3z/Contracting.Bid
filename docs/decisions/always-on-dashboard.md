# Always-on dashboard (2026-11-14)

The owner picked the always-on dashboard as the next slice. The dashboard can now stay up as a service and start runs itself, instead of living only as long as one run started from a terminal.

## What changed

- `pnpm sim serve` keeps the dashboard up until stopped (Ctrl+C, or a stop signal from Docker or systemd). It needs `DATABASE_URL`.
- A **Start a run** tab: pick `closeout`, `job`, `bid` or `hiring`, and optionally a job, a seed, Force award, and scripted models. The page shows the run in progress and the end of the last run's output.
- A run started there asks its approvals in the Approvals tab, streams its events to the Live log (cleared when a new run starts), and is saved to the database like any other run. Who decided each approval is recorded.
- A Compose `dashboard` service runs `serve` with `restart: unless-stopped`, after the `migrate` service. It uses the host network so it stays on 127.0.0.1, where Caddy already expects it.

## Made while building (please review)

1. **One run at a time.** A second start is refused until the first ends. Runs share the Claude budget per run, and the approval queue stays easy to follow. *Question:* do you want a queue, or several runs at once, later? -- Side-by-side.
   **Done (2026-11-14):** runs go side by side, up to `MAX_PARALLEL_RUNS` (default 3, at most 20). Each run keeps its own budget, so the most a busy service can spend at once is that many times `RUN_BUDGET_USD`. Approvals and live log lines name their run; when two runs ask approval number 1 at once, the page shows the second as #2 and notes its own number.
2. **Cloud models only from the dashboard.** The hybrid profile restarts vLLM through `vllm_service` on the host, which the container cannot do. Hybrid runs still work from the terminal.
3. **Only the stub jobs are offered.** The job list is the biddable stub solicitations. It will come from the real SAM.gov feed once that exists.
4. **Any signed-in user can start a run.** There is only one role today. The page shows who started the current and last run (not saved), and each saved approval records who decided it.
5. **A restart in the middle of a run leaves it unfinished.** The run's row and events so far stay in the database without an outcome; it is not resumed. Pending approvals are lost with it. *Question:* mark such runs "interrupted" on the next start, or try to resume them? -- yes (mark them).
   **Done (2026-11-14):** runs now record who started them (`started_by`, migration 003). On start, and on a stop with runs still going, the service marks its unfinished runs `interrupted` with a reason. Past runs lists them with the events they logged. Terminal runs are never touched, since the service cannot tell whether one is still going.
6. **No scheduling yet.** Runs start only when someone presses Start. Scheduled or recurring runs are a natural next step.
7. **The terminal commands are unchanged.** `pnpm sim closeout --dashboard` and `pnpm sim dashboard` still work as before; only one of them and the service can use port 4100 at a time.
8. **The old `app` container is out of `docker compose up`.** It only ran the tests and mounted `runs/`, which Docker Desktop refused to share from a OneDrive folder. It is now behind the `tools` profile (`docker compose --profile tools run --rm app`) without the mount, since runs live in the database.
9. **No host networking in Compose.** Docker Desktop runs containers in a VM, so `network_mode: host` put the dashboard on the VM's 127.0.0.1, out of reach from your desktop. The dashboard service now listens on 0.0.0.0 inside its container (allowed by `DASHBOARD_IN_CONTAINER=1`), and Compose publishes it only on the host's `127.0.0.1:${DASHBOARD_PORT:-4100}`. Caddy publishes 80 and 443 and forwards to `dashboard:4100` on the Compose network (`DASHBOARD_UPSTREAM` overrides it).
