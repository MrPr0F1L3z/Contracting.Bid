# Contracting.Bid

A general contracting company run by AI agents. The agents fill the company's roles, from President down to Bookkeeper, and the human owner only approves hires, money and contracts.

**Status:** sandboxed proof of concept. Nothing here talks to real clients, vendors, banks or bid portals. Jobs come from a stub of made-up federal construction solicitations; a read-only SAM.gov source comes in a later sprint.

## How it works

1. The company starts with one agent, the President (Claude).
2. The President hires HR. HR hires the Project Manager (Claude), then the Estimator, Procurement, Scheduler and Bookkeeper. You approve every hire.
3. The company picks a construction solicitation from the job source, estimates it, gets quotes from simulated vendors and subcontractors, and bids.
4. A world simulator plays the contracting officer, vendors, subcontractors and inspector. Each run injects 3 to 5 problems, such as late deliveries, change orders, failed inspections or late payment.
5. The run ends at closeout, with a report of margin vs. bid, days late, the problems handled, and model cost.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the code layout.

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
pnpm db migrate        # create or update the database tables
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

## Approving batches

Some approvals cover several items: all the subcontracts on a job, or a payment run of several bills. The terminal lists each item. Answer `y` to approve them all, `i` to go through them one by one, or anything else to reject the batch with your text as the reason. Items you leave out come back to the agent, which can ask again for them.

## Owner dashboard

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

### Reach the dashboard from other devices

The dashboard listens only on this machine until you set up HTTPS. The simplest way is Caddy, which gets and renews a free Let's Encrypt certificate:

1. Point a domain name (for example `dashboard.example.com`) at your machine's public IP address, with a DNS A record.
2. Open ports 80 and 443 on your router or firewall and forward them to this machine. Do not open 4100 or 5432.
3. In `.env`, set `DASHBOARD_DOMAIN=dashboard.example.com` and `DASHBOARD_BEHIND_PROXY=1`.
4. Start Caddy: `docker compose --profile public up -d caddy`.
5. Run the sim on this machine as usual, with `--dashboard`, and open `https://dashboard.example.com` on your phone.

The dashboard itself stays on 127.0.0.1; only Caddy faces the internet. `DASHBOARD_BEHIND_PROXY=1` marks the session cookie Secure, turns on HSTS, and takes the visitor's address from Caddy for the lockout.

If you already have a certificate (for example from certbot), the dashboard can serve HTTPS itself instead: set `DASHBOARD_HOST=0.0.0.0`, `DASHBOARD_TLS_CERT` and `DASHBOARD_TLS_KEY`. It refuses to serve plain HTTP on anything but 127.0.0.1.

## Database

With `DATABASE_URL` set, every `hiring`, `bid`, `job` and `closeout` run is saved in Postgres as well as in `runs/`: the report, every event as it happens, and the run's agents and approvals (including who decided). Dashboard logins live there too, and the dashboard's Past runs tab reads from it. Benchmarks (`bench`) are still files only.

- `pnpm db migrate` creates or updates the tables. Run it after `git pull` when a pull adds a file to `db/migrations/`; a run refuses to start until you do.
- `pnpm db status` shows which migrations are applied.
- `pnpm db import` copies your existing `runs/*.json` reports and `data/dashboard-users.json` logins into the database. It skips anything already there, so it is safe to run twice.

The sim runs on this machine, so `DATABASE_URL` uses `localhost`, not the container name `db`. Postgres only listens on 127.0.0.1. Remove `DATABASE_URL` to run without a database, as before.

## Tests

Every function has unit tests. Tests use scripted stub models and saved fixtures, so they never call Claude, vLLM or SAM.gov and cost nothing.

```bash
pnpm test
pnpm vitest run --coverage
```
