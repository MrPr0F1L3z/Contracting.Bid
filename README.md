# Contracting.Bid

A general contracting company run by AI agents. The agents fill the company's roles, from President down to Bookkeeper, and the human owner only approves hires, money and contracts.

**Status:** sandboxed proof of concept. Nothing here talks to real clients, vendors, banks or bid portals. Jobs come from a stub of made-up federal construction solicitations, or, if you set it up, from real SAM.gov listings, read-only (see [Real jobs from SAM.gov](#real-jobs-from-samgov)). Either way the bid, the job and the money stay inside the simulation.

## How it works

1. The company starts with one agent, the President (Claude).
2. The President hires HR. HR hires the Project Manager (Claude), then the Estimator, Procurement, Scheduler and Bookkeeper. You approve every hire.
3. The company picks a construction solicitation from the job source, estimates it, gets quotes from simulated vendors and subcontractors, and bids.
4. A world simulator plays the contracting officer, vendors, subcontractors and inspector. Each run injects 3 to 5 problems, such as late deliveries, change orders, failed inspections or late payment.
5. The run ends at closeout, with a report of margin vs. bid, days late, the problems handled, and model cost.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the code layout.

The customer-facing website and workspace are a separate package in [`web/`](web/README.md). It is a front end on sample data. The owner dashboard uses the same workspace layout and fills it from run data (`GET /api/workspace`); the site itself does not read it yet.

## Requirements

- Node.js 22 and pnpm (`corepack enable`)
- Docker with Compose, for Postgres
- A vLLM server on your machine with an OpenAI-compatible API (default `http://localhost:8001/v1`)
- An Anthropic API key

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in your keys and model name
docker compose up -d db
pnpm check             # typecheck + tests (no keys or GPU needed)
```

`pnpm sim`, `pnpm gpu` and `pnpm db` read `.env` from the folder you run them in. A variable you `export` in the shell wins over the file.

`VLLM_MODEL` in `.env.example` is a placeholder; set it to the exact model name your vLLM server reports.

## GPU sharing

Simulations need the GPU. Ollama and any existing vLLM processes may be stopped for a run. List the commands that stop and restart them in `GPU_PAUSE_HOOKS`. Pausing a process (`docker pause`, `kill -STOP`) keeps its VRAM allocated, so use real stop and start commands, for example:

```bash
GPU_PAUSE_HOOKS='[{"pause":"sudo systemctl stop ollama","resume":"sudo systemctl start ollama"},{"pause":"docker stop vllm","resume":"docker start vllm"}]'
```

The runner runs the stop commands before a simulation and always runs the start commands afterwards, in reverse order, even if the run fails. It runs only the commands you list.

### Reuse or restart vLLM

Before a run, the vLLM check reads `/metrics` for running and queued requests and times one short test request. It reuses the running server unless one of these is true, in which case it runs `vllm_service stop` then `vllm_service start big` and waits for the server to come up:

- all lanes are busy (`VLLM_MAX_LANES`, default 2, matching `--max-num-seqs` in the `big` profile) or requests are queued
- the test request takes longer than `VLLM_MAX_RESPONSE_SEC` (default 60)
- generation is slower than `VLLM_MIN_TOKENS_PER_SEC` (default 5)

```bash
pnpm gpu check           # report lanes and speed, change nothing
pnpm gpu ensure          # reuse, or stop and start fresh
pnpm gpu loadtest 3 3    # 3 background requests, then time 3 more while they run
```

The commands call `/usr/local/bin/vllm_service` directly, because the `vllm` alias only exists in interactive shells. `vllm_service start` uses `sudo systemctl`, so it needs passwordless sudo for that unit or it will stop and ask for a password. Override the commands with `VLLM_STOP_CMD` and `VLLM_START_CMD`.

## Run the hiring chain

```bash
pnpm sim hiring --stub             # dry run with scripted models: no API key, GPU or cost
pnpm sim hiring                    # cloud (default): President and PM on Opus, other roles on CLAUDE_WORKER_MODEL (Sonnet 5.5); no GPU
pnpm sim hiring --models hybrid    # hybrid: President and PM on Claude, other roles on your local vLLM model
pnpm sim bench --runs 3            # 3 runs of each profile, alternating, then a time and cost comparison
```

The President hires an HR rep, and HR hires a Project Manager. Both hires are automatic. Any other hire an agent proposes asks you in the terminal (`y` approves; anything else rejects, and your text is the reason). A hybrid run checks vLLM first (see above). A real run needs `ANTHROPIC_API_KEY`, and is capped at `RUN_BUDGET_USD` (default $5) of Claude spend. Each run writes a JSON report to `runs/`, including every event and the wall-clock time of each task. A benchmark declines any hire beyond the automatic two, so every run does the same work.

## Run a bid

```bash
pnpm sim bid --stub                        # dry run on STUB-E02 with scripted models; every gate approved
pnpm sim bid                               # cloud: a job picked by seed; you approve each gate in the terminal
pnpm sim bid --complexity moderate         # pick only among moderate jobs
pnpm sim bid --job STUB-C01 --seed 42      # a given job; the same seed replays the same market and competitors
pnpm sim bid --auto-approve                # approve every gate without asking (simulation only)
```

After the two automatic hires, the President decides whether to pursue the job. If you approve, HR hires an Estimator and a Procurement agent (you approve each hire), the Estimator prices each trade, Procurement gets and selects subcontractor quotes, and the PM sets the bid price, which you approve before it goes to the simulated contracting officer. The award goes to the lowest responsive bid; a bid with no selected quote for a trade the job needs is not responsive. The company never takes a job at a loss: `submit_bid` refuses any price below the total of the selected quotes, before it reaches you. The run's seed draws its real-world problems; in this slice, `quote-expired` makes one trade's sub re-quote 8–15% higher.

## Run a job

```bash
pnpm sim job --stub --seed 3 --force-award   # dry run: bid STUB-E02, then run it with the seed's site problems
pnpm sim job --job STUB-M01                  # bid, and if you win, run the job; you approve each gate
pnpm sim job --auto-approve --force-award    # unattended: every gate approved, and a responsive losing bid is awarded anyway
```

`job` takes the same flags as `bid`. If the bid wins (or `--force-award` is set and the bid was responsive), the PM gets the prime contract and the subcontracts signed (you approve both), HR hires a Scheduler (you approve), the Scheduler sequences the trades, and the PM resolves each site problem the seed drew: late deliveries, weather, sub no-shows, double-booked crews, failed inspections, change orders and hidden conditions. Each priced change order goes to you before the contracting officer sees it. The run ends with the job's final account: revenue, cost, profit, days late and liquidated damages.

## Close out a job

```bash
pnpm sim closeout --stub --seed 3 --force-award   # dry run of the whole lifecycle, from hiring to a closed job
pnpm sim closeout --job STUB-E02 --force-award    # the same with real models; you approve each gate
```

`closeout` takes the same flags as `job`. After the job finishes, HR hires a Bookkeeper (you approve). The Bookkeeper drafts the final invoice, which you approve before it is sent. It must equal the contract price plus approved change orders, less liquidated damages; a wrong invoice is returned and delays payment. The Bookkeeper then pays every subcontractor and vendor bill, and you approve each payment run. The government pays in 30 days. If the seed drew `late-payment`, it pays late and holds back part of the invoice, and the Bookkeeper decides whether to claim Prompt Payment Act interest and whether to submit closeout documents to release the money held back. The PM then asks you to close the project. The report ends with the cash position: received, paid out and cash profit.

## Real jobs from SAM.gov

Runs can bid real, current federal construction solicitations instead of the made-up ones. Contracting.Bid only reads listings from SAM.gov; it never submits anything, and the bid, the subcontractors, the award and the money are still simulated.

1. Get a public API key: sign in at [SAM.gov](https://sam.gov), open **Account Details** from your profile, enter your password, and copy the **Public API Key** it shows.
2. In `.env`, set `SAM_GOV_API_KEY` to that key and `JOB_SOURCE=samgov`. Optional: `SAMGOV_STATE` (two letters), `SAMGOV_NAICS` (codes, comma separated), `SAMGOV_LOOKBACK_DAYS` (default 30).
3. Check what comes back:

```bash
pnpm sim listings                         # the jobs a run can bid, soonest due first
pnpm sim listings --refresh               # read SAM.gov now instead of the cache
pnpm sim closeout --job NOTICE_ID --force-award
pnpm sim bid --source stub                # the made-up jobs, whatever JOB_SOURCE says
```

SAM.gov allows only a few requests a day per key, so listings are cached (in the database, or in `data/samgov-listings.json` without one) and read again at most every `SAMGOV_CACHE_HOURS` (default 24). A read asks for solicitations and combined synopses posted in the window and keeps active ones under construction NAICS codes (236, 237, 238); that is two requests, or two per code in `SAMGOV_NAICS`. A run fetches the description of the one job it bids, once, and keeps it in the cache. If SAM.gov is down or over the limit, the cached listings are used.

A real listing has no written-out scope, so the world infers its trades from the NAICS code and the words in the notice, and draws its hidden value (when the notice gives no estimate) and its contract time from the seed. Each run keeps a copy of the listing it bid in its `opportunity_found` event. The always-on dashboard offers the listings it read when it started; restart it to pick up new ones.

## Approving batches

Some approvals cover several items: all the subcontracts on a job, or a payment run of several bills. The terminal lists each item. Answer `y` to approve them all, `i` to go through them one by one, or anything else to reject the batch with your text as the reason. Items you leave out come back to the agent, which can ask again for them.

## Owner dashboard

The dashboard is laid out as the Blueprint workspace of the customer site: Overview, Find work, Bids, Projects, Subs & vendors, Schedule, Money and Closeout in the sidebar, each filled from your runs (live runs as they go, plus the latest saved ones). Click a job for its stages, quotes, schedule, problems, hired team and your decisions. **Settings**, at the foot of the sidebar, holds the owner's tools as tabs: **Approvals**, **Live log**, **Past runs** and **Start a run**. Overview and the Settings link show how many approvals are waiting.

First create your login. You need a password of at least 12 characters and an authenticator app on your phone (1Password, Google Authenticator, Authy or similar):

```sh
pnpm sim user add owner
```

It shows a secret key (and an `otpauth://` link) to add to the app, then asks for a code from the app to check it worked. Logins are saved in `data/dashboard-users.json`, readable only by you. Use `pnpm sim user passwd NAME` to change a password, `reset-code NAME` for a new phone, `remove NAME` and `list`.

Add `--dashboard` to a `bid`, `job` or `closeout` run to answer approvals in your browser instead of the terminal:

```sh
pnpm sim closeout --job STUB-E02 --force-award --dashboard
```

The terminal prints the link, `http://127.0.0.1:4100/` by default. Sign in with your name, password and the current code from your app. The page has three tabs:

- **Approvals:** each pending request, with Approve, Reject and a reason. Batches list their items, with "Approve all" and "Approve checked only".
- **Live log:** the run's events as they happen.
- **Past runs:** the saved reports, with each run's approvals and events.

The run waits for you on the page. It closes when the run ends. To browse saved reports afterwards, run `pnpm sim dashboard` (add `--out DIR` if you saved them elsewhere) and press Ctrl+C to stop it. Set `DASHBOARD_PORT` to use a port other than 4100. `--dashboard` does nothing with `--auto-approve` or `--stub`, which approve everything themselves.

Five wrong sign-ins lock that name and that address out for 15 minutes. A session ends after an hour without use, or 12 hours after sign-in, and restarting the dashboard signs everyone out.

### Keep the dashboard running

`pnpm sim serve` keeps the dashboard up and adds a **Start a run** tab to Settings: pick `closeout`, `job`, `bid` or `hiring`, optionally a job, a seed and Force award, and start it. Its approvals show in the Approvals tab and its events in the Live log, and it is saved to the database. Runs go side by side, up to `MAX_PARALLEL_RUNS` at once (default 3), each with its own `RUN_BUDGET_USD` cap, so three runs can spend up to three times that. Each approval card and live log line names its run. Tick "Scripted models" for a free dry run. It needs `DATABASE_URL`.

If the service stops in the middle of a run (a restart, a crash, `docker compose stop`), the run is marked **interrupted** in the database and shows that way under Past runs, with the events it logged. It is not resumed. Runs started in a terminal are never marked.

To have it start with the machine and come back after a crash, run it with Docker Compose instead:

```sh
docker compose up -d dashboard
```

It reads `.env` (your API key and dashboard settings) and uses the logins in the database. Open `http://127.0.0.1:4100/` (or your `DASHBOARD_PORT`) on this machine: the port is published only on 127.0.0.1, so other devices go through Caddy (below). Its log prints `http://0.0.0.0:4100/`, the address inside the container. Plain `docker compose up -d` starts the same three services (`db`, `migrate`, `dashboard`). `docker compose logs -f dashboard` shows its output and `docker compose stop dashboard` stops it. Runs started there use cloud models only, since vLLM is controlled from the host. After a `git pull`, rebuild it with `docker compose up -d --build dashboard`.

### Reach the dashboard from other devices

The dashboard listens only on this machine until you set up HTTPS. The simplest way is Caddy, which gets and renews a free Let's Encrypt certificate:

1. Point a domain name (for example `dashboard.example.com`) at your machine's public IP address, with a DNS A record.
2. Open ports 80 and 443 on your router or firewall and forward them to this machine. Do not open 4100 or 5432.
3. In `.env`, set `DASHBOARD_DOMAIN=dashboard.example.com` and `DASHBOARD_BEHIND_PROXY=1`.
4. Start Caddy and the dashboard service: `docker compose --profile public up -d caddy` (it starts `dashboard` too).
5. Open `https://dashboard.example.com` on your phone.

Caddy forwards to the dashboard service over the Compose network; the dashboard is never published beyond 127.0.0.1, so only Caddy faces the internet. Caddy fronts the service, not a terminal `--dashboard` run. `DASHBOARD_BEHIND_PROXY=1` marks the session cookie Secure, turns on HSTS, and takes the visitor's address from Caddy for the lockout.

If you already have a certificate (for example from certbot), the dashboard can serve HTTPS itself instead: set `DASHBOARD_HOST=0.0.0.0`, `DASHBOARD_TLS_CERT` and `DASHBOARD_TLS_KEY`. It refuses to serve plain HTTP on anything but 127.0.0.1, except inside the Compose service, where `DASHBOARD_IN_CONTAINER=1` allows it because the port is published only on this machine's 127.0.0.1.

## Dev, staging and prod

This checkout is the dev stack. Committed builds go to staging with `pnpm stack deploy staging`, which builds and tests them; a build that passes goes to prod with `pnpm stack promote` in a maintenance window, once staging has 10 closeout runs that closed with no owner intervention. Prod has its own database, never runs simulations and never shows sim data. See [docs/STACKS.md](docs/STACKS.md).

The customer site (`web/`) deploys to the cPanel host: every push to `main` goes to https://staging.contracting.bid, and a build that passed staging is promoted to https://www.contracting.bid in the maintenance window. One-time setup is `pnpm cpanel setup` on your machine. See [docs/CPANEL.md](docs/CPANEL.md).

## Database

With `DATABASE_URL` set, every `hiring`, `bid`, `job` and `closeout` run is saved in Postgres instead of `runs/`: the report, every event as it happens, and the run's agents and approvals (including who decided). Dashboard logins live there too, and the dashboard's Past runs tab reads from it. Benchmarks (`bench`) are still files only.

- New migrations in `db/migrations/` are applied automatically when a run starts (and by the `migrate` service on `docker compose up`). They are applied together in one transaction: if any fails, none are, the database is left as it was, and the run does not start. CI applies them to a fresh Postgres on every pull request.
- `pnpm db migrate` applies them without starting a run. `pnpm db status` shows which are applied.
- `pnpm db export RUN_ID` writes one run's report to `runs/RUN_ID.json`, to share it. The dashboard's Past runs tab shows the run IDs.
- `pnpm db delete` removes saved runs with their events, approvals and agents. It only lists what it would remove until you add `--yes`, and it cannot be undone, so export a run first if you want a copy.
  - `pnpm db delete RUN_ID` removes one run.
  - `pnpm db delete --before now` removes every run so far. `--before 14:30:00` means that time today, `--before 261115` (or `2026-11-15`) the start of that day, and `--before 261115 14:30:00` that day at that time. Times are this machine's local time.
  - Runs that have not finished are left alone unless you add `--include-unfinished`.
- `pnpm db import` copies your existing `runs/*.json` reports and `data/dashboard-users.json` logins into the database. It skips anything already there, so it is safe to run twice.

The sim runs on this machine, so `DATABASE_URL` uses `localhost`, not the container name `db`. Postgres only listens on 127.0.0.1. Remove `DATABASE_URL` to run without a database; reports are then written to `runs/` as before.

## Tests

Every function has unit tests. Tests use scripted stub models and saved fixtures (`test/fixtures/samgov-search.json` is made up), so they never call Claude, vLLM or SAM.gov and cost nothing.

```bash
pnpm test
pnpm vitest run --coverage
```
