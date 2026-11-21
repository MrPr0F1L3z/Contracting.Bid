# Dev, staging and prod stacks (2026-11-21)

The owner asked for the split: make changes locally against dev, push to staging for testing, on PASS push to prod in a maintenance window, on FAIL send the errors back to dev, fix, and redeploy to staging. Staging shows sim-world data. Prod has its own database, never shows sim data, and fills only from real use with SAM.gov. Promotion waits for 10 successful runs with no human intervention. How-to: [docs/STACKS.md](../STACKS.md).

## What changed

- **Three stacks from one Compose file.** dev is the checkout as today (`docker compose up -d`, same database and ports). staging (`contracting-staging`, ports 4200/5433) and prod (`contracting-prod`, 4300/5434) get their names and ports from `deploy/stacks/STACK.env`, and Compose gives each project its own database volume.
- **`pnpm stack`**, the pipeline. `deploy staging` exports a commit from git, builds `contracting-bid:<commit>`, runs the unit tests in that image, starts staging (database, migrations, login check, dashboard) and checks it. `promote` puts a build that passed staging on prod. `status`, `test staging` and `user STACK ...` round it out.
- **FAIL goes back to dev as a report.** The first failed step stops the deploy. The report (`STACKS_DIR/reports/...md`) names the step and has its output; the terminal says to fix on dev, commit and deploy again. A deploy history is kept in `STACKS_DIR/ledger.json`.
- **Prod never runs simulations.** With `APP_STACK=prod`, every sim run command refuses before it opens the database (exit 3), the dashboard has no Start a run tab, and `pnpm db import` is off. Staging checks this on every build.
- **Each database knows its stack** (migration 004). The first process to open it records its `APP_STACK`; any other stack refuses to use it, before migrating it.
- **Prod deploys are guarded.** Only a build that passed staging; only when the gate is met; only inside `PROD_MAINTENANCE_WINDOW`; and it asks first. It saves the prod database with `pg_dump` (file readable only by you), restarts, checks health, migrations and the sim refusal, and goes back to the previous build if a check fails.
- **`/healthz`** on the dashboard (no sign-in) reports `{ ok, stack, build }`, so a deploy can check the right build answers. The dashboard shows a Dev / Staging / Production badge.
- **Runs record how they were set up**: `stub`, `autoApprove`, `forceAward` and the build go in `runs.model_config`, which the gate reads.
- **Start a run** has a new **Approve every gate automatically** option, so the unattended runs can be started from staging's dashboard.
- **Caddy** shows a maintenance message while the dashboard restarts. CI renders all three stacks' Compose config and checks their names, ports and `APP_STACK`.

Tested: 600+ unit and functional tests, plus the whole pipeline run for real in Docker: a staging FAIL (with its report), a staging PASS, the gate refusing at 0 of 10, the window refusing outside it, a first prod deploy stopping for a missing login, then a PASS with a backup. Prod's database had no runs; staging's had only its own check runs.

## Made while building (please review)

1. **What counts as "no human intervention".** **Decided (2026-11-21): no owner decisions at all.** A full `closeout` run that ended **closed**, on real models, where every approval was automatic. Any approve or reject click disqualifies it. The other option (`approvals-only`: Approve clicks fine, no rejections or partial approvals) is one setting away: `PROMOTE_RUN_RULE=approvals-only`. Forced awards still count, since they are a sim setting rather than a human decision. *Question:* should a forced award disqualify a run?
2. **The 10 runs are counted across staging, not per build.** Re-earning 10 runs for every release would cost about $50 each time. Every later release still has to pass the staging checks. *Question:* per build instead?
3. **All three stacks share this machine.** There is no other host. They are separate Compose projects with separate databases, ports and volumes.
4. **The maintenance window is a setting**, in this machine's local time, with no default: promote refuses until you set it. `--outside-window` exists for emergencies and says so loudly.
5. **Staging and prod build from git, never from the working copy.** `deploy staging` with uncommitted changes refuses. This is the "no edits on the server, only through the pipeline" rule.
6. **Builds, reports and backups live outside the checkout**, in `~/.local/share/contracting-bid/stacks` (`STACKS_DIR`), so they don't sync to OneDrive. Prod backups hold login hashes and authenticator secrets.
7. **Logins are per stack.** A new staging or prod database has none, and the dashboard won't start without one, so the first deploy stops and says to run `pnpm stack user STACK add NAME`. Logins are not copied from dev on purpose.
8. **The public domain points at prod.** Only one Caddy can hold ports 80 and 443, and prod is the one meant for real use. Staging stays on 127.0.0.1:4200. Turn it on with `PROD_PUBLIC=1` after stopping dev's Caddy.
9. **A failed prod deploy goes back to the previous build but does not restore the database.** Migrations are additive so far, and restoring would throw away anything written since the backup. The report gives the backup path and the restore command.
10. **Database passwords are still the defaults** (localhost-only ports). Before prod holds real data, move them into `.env`.
11. **Your current data stays on dev.** Nothing was moved or deleted. Staging and prod start empty.
