# Architecture

The full POC spec lives in the project's Claude Doc, "Contracting.Bid POC: Process map and spec". This file covers how the code is laid out.

## Decisions

- Paperclip AI is a design reference, not a fork. We borrow its ideas: hires as config records, heartbeats, budgets with hard stops, approval gates, and versioned agent config.
- TypeScript on Node.js 22, tested with Vitest.
- Claude (`claude-opus-5-5`) runs the President and Project Manager. One local model on vLLM runs every other role and the simulated counterparties. With 24GB of VRAM, only one local model fits at a time.
- Everything runs on the owner's machine with Docker Compose. CI and cloud sessions only use stub models and saved fixtures.
- The company is a general contractor that subcontracts all work. For the POC, jobs come from a stub of made-up federal construction solicitations. A read-only SAM.gov source will plug into the same `OpportunitySource` interface in a later sprint.

## Layout

| Path | What it does |
| --- | --- |
| `src/models/` | Provider-neutral model types, the Claude and vLLM providers, a scripted stub, record/replay wrappers, and the role router |
| `src/config/` | Environment config and the role list: who reports to whom, and which model family runs each role |
| `src/sim/` | Seeded RNG, the simulated clock, the problem catalog, and the hiring chain (slice 1) |
| `src/events/` | Append-only event log, in memory during a run |
| `src/db/` | The `Db` interface over `pg`, the migration runner, and the Postgres stores for runs, events and logins |
| `src/budget/` | Per-call cost and budgets that warn at 80% and stop at 100% |
| `src/approvals/` | The nine owner approval gates and the approval queue, with batch approvals that can be approved in full or item by item |
| `src/opportunities/` | The `OpportunitySource` interface, the stub source of made-up solicitations (two each at easy, moderate and complex), the seeded picker, and a coverage planner that spreads runs across complexity levels |
| `src/agents/` | Agent records and the hiring policy, the agent tool loop (budgets, event logging, Claude's thinking passed back unchanged), and the hiring tools |
| `src/gpu/` | Pauses the owner's listed GPU processes before a run and always resumes them afterwards; checks vLLM lanes and speed and restarts it when needed |
| `src/dashboard/` | The owner dashboard: a local web page for approvals, the live event log and saved reports |
| `src/cli/` | `pnpm gpu` (vLLM check, ensure, load test), `pnpm sim` (hiring, bench, bid, job, closeout, dashboard, user) and `pnpm db` (migrate, status, import) |
| `db/migrations/` | Postgres schema for the data model, applied in order when a run starts (or by `pnpm db migrate`) |
| `test/` | Unit tests for every function, plus functional tests that apply the schema to an embedded Postgres |

## Determinism and replay

Every random choice goes through `SeededRng`, and each concern forks its own stream (`rng.fork("problems")`), so a new random draw in one place never shifts another. Agents wake on `SimClock` ticks, never on wall-clock time. `RecordingProvider` saves every model response, and `ReplayProvider` serves them back, so a replay matches exactly even when a local model is not deterministic.

## Hiring (slice 1)

The owner appoints the President. The President hires HR with `propose_hire`, writing HR's standing instructions; HR then hires the Project Manager the same way. These two hires are automatic by the owner's rule (`INITIAL_HIRES`): they are recorded as approvals flagged `autoApproved` but never wait on the owner. Any other hire waits for the owner's answer. `hirePolicy` lets the President hire only HR and lets HR hire every other role; a hire's manager comes from the org chart (`REPORTS_TO`), so the PM reports to the President even though HR hired it.

Each agent task runs in `runAgentTask`: call the model, run the tools it asks for, return all results in one message, and repeat until it stops calling tools. Every model call is charged to both the run budget and the agent's own budget, and the loop stops before a call once either is spent. Calls to the local model share a semaphore sized to `VLLM_MAX_LANES`, so extra calls wait in our code instead of queueing inside vLLM.

## Bid and award (slice 2)

`Company` (`src/sim/company.ts`) holds one run's registry, approvals, budget, event log and task records; each slice drives it through its part of the job lifecycle. `runBidChain` reuses slice 1's hires, then:

1. Draws the run's problems and picks a job from the seed (or `--job` / `--complexity`), and builds a `BidWorld`.
2. The President calls `decide_opportunity`. Pursuing goes to the owner (`pursue_opportunity`).
3. HR receives a written request from the President and hires an Estimator and a Procurement agent. Each hire goes to the owner.
4. The Estimator calls `submit_estimate` with one line per trade, using the market's trade names.
5. Procurement calls `request_quotes` and `select_quote` per trade, and `procurement_status` to check for gaps.
6. The PM gets a bid package (estimate next to the selected quotes) and calls `submit_bid`. The owner approves the price (`submit_bid`) before it is submitted; a rejected price comes back as a tool error so the PM can revise.
7. The contracting officer awards on lowest price technically acceptable.

`BidWorld` (`src/world/market.ts`) is the simulated outside world for one bid. Each stub job has a hidden list of required trades and cost shares (`JOB_SCOPES`); the true subcontract cost is 75–90% of the government estimate's midpoint. Each trade gets 2–3 quotes at 92–130% of its true cost, and 2–4 competitors bid 108–135% of the total true cost. Every draw uses its own forked RNG stream, so a seed replays the same world regardless of the order agents ask for things.

## Execution (slice 3)

`runJobChain` (`src/sim/jobChain.ts`) runs the bid stage, then the awarded job on a `SiteWorld` (`src/world/site.ts`):

1. Kickoff: the PM calls `sign_prime_contract` (owner gate `sign_contract`) and `issue_subcontracts` (one `sign_commitment` gate for all selected subcontracts).
2. HR hires a Scheduler from a written request. The Scheduler calls `set_schedule` with the trades in order; `TRADE_RANK` rejects an impossible order (flooring before painting, for example). Trades run one after another and use 90% of the contract time (`JOB_DURATION_DAYS`).
3. Each execution problem the seed drew fires on a day set by its `phaseProgress` and hits the trade working that day (hidden conditions hit the first trade, on day one). The PM gets a brief with fixed options (`resolve_problem`) or, for a change order or hidden condition, prices a change order (`price_change_order`, owner gate `approve_change_order`). The contracting officer accepts a price up to 10% over cost plus 15%; after three rejections the work goes ahead under dispute, unpaid. If the PM never decides, the site takes the slowest option.
4. `finalAccount()` totals revenue (contract plus change orders, less liquidated damages), cost (subcontracts plus problem costs) and time.

Scripted runs use `ReactiveProvider`, which answers each request from the tools on offer, because the problems a run meets depend on its seed.

## Closeout, AR and AP (slice 4)

`runCloseoutChain` (`src/sim/closeoutChain.ts`) runs the job stage, then closes the job on a `LedgerWorld` (`src/world/ledger.ts`):

1. HR hires a Bookkeeper from a written request.
2. The Bookkeeper gets the invoice figures and the bills. The bills are one per subcontract, plus one for each problem that cost money, so they add up to the job's cost. The Bookkeeper calls `submit_invoice`; the contracting officer accepts only the exact amount due. It then calls `pay_bills`; each payment run is an owner gate (`release_payment`).
3. The government pays 30 days after acceptance, plus 10 days for each returned invoice. With `late-payment`, it pays 15–45 days late and withholds 2–5%. That raises two receivable issues for `resolve_receivable`: claim interest or waive it, and submit closeout documents or write off the amount withheld. An issue the Bookkeeper leaves open is written off.
4. The PM calls `close_project`, which refuses while anything is outstanding, then asks the owner (`close_project`).

Each stage function (`bidStage`, `jobStage`) returns where it stopped, so each slice builds on the one before it, and each `run*Chain` writes one report.

## Owner dashboard

`DashboardServer` (`src/dashboard/server.ts`) is a small `node:http`/`node:https` server with the page inline in `src/dashboard/page.ts`. Logins are in `src/dashboard/auth.ts`, and `pnpm sim user` (`src/cli/dashboardCli.ts`) manages them. It has no dependencies.

- `approver()` is an `Approver` that parks each request until the owner answers it on the page. Batch requests can be approved in full or by item.
- `tee(log)` wraps the run's event log, so every event also streams to the page over server-sent events (`/api/stream`).
- `/api/runs` lists the reports in the `--out` folder, and `/api/runs/:file` reads one. Only plain `*.json` names holding an object with a `runId` are served.
- **Sign-in:** name, password (scrypt) and a TOTP code (RFC 6238, one step of drift, no code used twice). A wrong answer gets the same message whatever was wrong. Five failures lock the name and the address for 15 minutes.
- **Sessions:** in memory, in an `HttpOnly; SameSite=Strict` cookie (`__Host-` and `Secure` under HTTPS). They end after an hour idle or 12 hours. Every POST needs the page's `x-requested-with` header, a same-origin `Origin` when sent, and the session's CSRF token. A decision records who made it (`decidedBy: owner:NAME`).
- **Transport:** HTTP on 127.0.0.1 only, or HTTPS from its own certificate, or behind Caddy (`deploy/Caddyfile`, compose profile `public`), which gets a Let's Encrypt certificate. HSTS is on whenever it is reached over HTTPS.
- The page sets a strict content security policy and builds the DOM with `textContent` only, so agent text cannot inject script.
- `UserStore` is an interface: `PgUserStore` (the `dashboard_users` table) when `DATABASE_URL` is set, a mode-600 JSON file otherwise.

## Database

`src/db/` keeps runs in Postgres when `DATABASE_URL` is set. Everything goes through a small `Db` interface (`query`, `exec`, `transaction`), backed by `pg` in real runs and an embedded Postgres (PGlite) in tests.

- **Migrations:** `db/migrations/NNN_name.sql`, applied in order and recorded in `schema_migrations`. Every run, `pnpm db` command and the Compose `migrate` service applies the pending ones first, all in one transaction, so a failure rolls them all back and the run does not start. A database the container set up before tracking existed is recorded as already having 001. CI applies them to a fresh Postgres.
- **Events:** `PersistentEventLog` wraps the run's in-memory log. `append` stays synchronous, so a run plays out the same with or without a database. It queues each insert in order, and `flush()` waits for them and reports the first failure.
- **Runs:** `RunStore.start` inserts the `runs` row before the first event. `finish` saves the report JSON, its outcome columns, and the run's agents and approvals in one transaction. With a database, no report file is written; `pnpm db export RUN_ID` writes one on demand.
- **The dashboard** reads Past runs from `RunStore` instead of the reports folder.

## Next

1. The real SAM.gov source in place of the stub.
2. An always-on dashboard service that starts runs itself, now that runs live in the database.
