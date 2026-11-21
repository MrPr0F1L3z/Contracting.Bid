# Dev, staging and prod

Contracting.Bid runs as three stacks on this machine. Each has its own database and its own dashboard.

| Stack | What it runs | Data | Jobs from | Dashboard | Database |
|---|---|---|---|---|---|
| dev | this checkout, as you change it | sim runs | `JOB_SOURCE` in `.env` (stub by default) | 127.0.0.1:4100 | 127.0.0.1:5432 (the one you have today) |
| staging | one committed build under test | sim runs | SAM.gov (`deploy/stacks/staging.env`) | 127.0.0.1:4200 | 127.0.0.1:5433 |
| prod | a build that passed staging | real use only, never sim data | SAM.gov, always | 127.0.0.1:4300 (and your domain, see below) | 127.0.0.1:5434 |

## The flow

```
change things on dev ──► commit ──► pnpm stack deploy staging
                                        │
                     FAIL ◄─────────────┴──────────► PASS
                       │                              │
   report for dev (path printed);           pnpm stack promote, inside the
   fix on dev, commit, deploy again         maintenance window, once staging has
                                            10 runs with no owner intervention
```

1. **Dev.** Work as today: `docker compose up -d`, `pnpm sim closeout --stub`, `pnpm test`. Nothing about dev changed, and it keeps the database you already have.
2. **Staging.** Commit, then run `pnpm stack deploy staging`. It:
   - exports that commit from git (never your working copy, so what is tested is exactly what was committed),
   - builds the image `contracting-bid:<commit>`,
   - runs the unit tests inside that image,
   - starts staging's database, applies migrations (all or nothing), checks a dashboard login exists, starts the dashboard,
   - checks the dashboard answers as staging on that commit, that every migration is applied, that a scripted closeout run closes on staging, and that the image refuses sim runs when it runs as prod.

   **PASS** prints the next step. **FAIL** stops at the first failed check, leaves staging as it is for you to look at, and writes a report (path printed) with the failing output. Fix it on dev, commit, deploy again.
3. **The gate.** Run real closeout runs on staging: on its dashboard (127.0.0.1:4200), **Start a run**, closeout, with **Approve every gate automatically** ticked. `pnpm stack status` shows how many count. A run counts when it is a full `closeout` run that ended **closed**, used real models (not `--stub`), and had **no owner decisions** (every approval automatic). Prod needs 10 (`PROMOTE_MIN_RUNS`).
4. **Prod.** `pnpm stack promote` puts the newest build that passed staging on prod. It refuses unless the gate is met and the time is inside `PROD_MAINTENANCE_WINDOW`, then asks you to confirm. It saves the prod database to a file first, restarts prod on the new build, and checks it. If a check fails it goes back to the previous build and writes a report, the same as staging.

Prod never runs simulations: every sim command refuses there, its dashboard has no **Start a run** tab, and `pnpm db import` is turned off. Its jobs only ever come from SAM.gov: it refuses `JOB_SOURCE=stub`, never shows the stub's made-up jobs, and reads SAM.gov listings into its own database when it starts. A prod deploy checks it can read them.

## Where staging's jobs come from

Staging's runs bid real SAM.gov listings (read-only; the bid, subs, award and money are still simulated). The setting is one line in `deploy/stacks/staging.env`:

```
JOB_SOURCE=samgov    # or stub, for the made-up jobs
```

To switch, change that line, commit, and run `pnpm stack deploy staging`. Staging and prod need `SAM_GOV_API_KEY` in this checkout's `.env` (see the README, Real jobs from SAM.gov). A staging deploy checks that staging can read its listings, and that the build refuses stub jobs when it runs as prod. The deploy's own scripted closeout check still bids the stub job, since the scripted models only know that one. Each database also records which stack it belongs to the first time it is used, and refuses any other, so prod can never be pointed at staging's data by mistake.

## First time

1. Add to `.env` (it stays on this machine):
   ```
   PROD_MAINTENANCE_WINDOW=daily 22:00-06:00
   PROD_MAINTENANCE_TZ=America/Los_Angeles
   ```
   That is your window: every night from 10 pm to 6 am Pacific time (it follows daylight saving time). A window that ends before it starts runs past midnight. Other forms: `Sun 02:00-04:00`, several separated by commas. Without `PROD_MAINTENANCE_TZ` the times are this machine's local time.
2. Deploy staging: `pnpm stack deploy staging`. The first time, it stops at **dashboard login exists**, because the new database has no logins. Add one, then deploy again:
   ```
   pnpm stack user staging add owner
   pnpm stack deploy staging
   ```
3. Prod is the same the first time you promote: `pnpm stack user prod add owner`, then `pnpm stack promote` again. Logins are per stack, so use a separate authenticator entry for each.

## Commands

```
pnpm stack status                       what each stack runs, whether it answers, and the gate
pnpm stack deploy staging [--ref REF]   deploy a commit (default HEAD; must be committed)
pnpm stack test staging                 run the staging checks again
pnpm stack promote [--ref BUILD] [--yes] [--outside-window]
pnpm stack user staging|prod add|list|passwd|reset-code|remove NAME
```

`--outside-window` is for emergencies only; the deploy says loudly that it ran outside the window. `--yes` skips the confirmation.

## Settings (in `.env`)

| Setting | Default | What it does |
|---|---|---|
| `PROD_MAINTENANCE_WINDOW` | none (promote refuses) | when prod may change; yours is `daily 22:00-06:00` |
| `PROD_MAINTENANCE_TZ` | this machine's time zone | the time zone of the window, such as `America/Los_Angeles` |
| `PROMOTE_MIN_RUNS` | 10 | unattended closeout runs staging needs |
| `PROMOTE_RUN_RULE` | `no-owner-decisions` | or `approvals-only`: Approve clicks are fine, rejections and partial approvals are not |
| `PROD_PUBLIC` | off | `1` starts Caddy with prod, serving `DASHBOARD_DOMAIN` over HTTPS |
| `STACKS_DIR` | `~/.local/share/contracting-bid/stacks` | builds, reports, prod backups and the deploy ledger (kept out of the OneDrive checkout) |

Ports and names for each stack are in `deploy/stacks/STACK.env` (committed, no secrets). Staging and prod read the Claude API key from this checkout's `.env`, and Docker gets nothing else from it, so `.env` cannot change a stack's ports.

## Reaching prod from other devices

Ports 80 and 443 can belong to one Caddy only. If dev's Caddy is running, stop it first (`docker compose --profile public stop caddy`), then set `PROD_PUBLIC=1` and `DASHBOARD_DOMAIN` in `.env` and promote. During a deploy the page says the dashboard is down for maintenance. Staging stays on 127.0.0.1:4200.

## Files

- Reports: `STACKS_DIR/reports/<stack>-<build>-<time>.md`
- Prod backups: `STACKS_DIR/backups/prod-<time>-before-<build>.sql` (readable only by you). Restore one only on purpose: `docker compose -p contracting-prod exec -T db psql -U contracting contracting < FILE`.
- History: `STACKS_DIR/ledger.json`
