# DB layer (2026-11-10)

The owner asked for the DB layer after dashboard logins. Runs, their events, agents and approvals, and dashboard logins are now kept in Postgres when `DATABASE_URL` is set.

## What changed

- `pnpm db migrate | status | import`. Migrations are tracked in `schema_migrations`. Migration `002_runs_users.sql` adds run columns, ties agents and approvals to runs, and adds `dashboard_users`.
- `hiring`, `bid`, `job` and `closeout` runs write every event to Postgres as it happens, and save the report with its agents and approvals at the end.
- Dashboard logins and Past runs come from the database.
- `pnpm db import` copies existing report files and the logins file into the database.
- The Postgres container no longer applies the schema itself on first start; `pnpm db migrate` owns the schema.

## Made while building (please review)

1. **The database is used when `DATABASE_URL` is set, and a run will not start without it then.** If Postgres is down, the run stops with a clear message rather than quietly skipping the save. Remove `DATABASE_URL` to run without one.
2. **Report files are still written.** `runs/*.json` stays as a backup and for sharing. *Question:* keep both, or stop writing files once you trust the database? -- Stop writing.
   **Done (2026-11-14):** with `DATABASE_URL` set, runs no longer write `runs/*.json`. `pnpm db export RUN_ID` writes one on demand, for sharing. Without a database, runs still write files, since that is their only record.
3. **Migrations are run by hand** (`pnpm db migrate`), not on every run, so a schema change never happens without you seeing it. -- Run as part of CI/CD; ensure auto rollback on failure.
   **Done (2026-11-14):** pending migrations are applied together in one transaction, so if any fails none are applied and the database is left as it was. They are applied automatically when a run starts, by every `pnpm db` command, and by a `migrate` service on `docker compose up` (the app waits for it). CI applies them to a fresh Postgres on every pull request, and a test checks the rollback on a real Postgres. *Question:* there is no deploy pipeline beyond your machine yet; when there is one, it should run `pnpm db migrate` as its first step.
4. **The sim's event log stays in memory during a run** and is copied to Postgres in order as it goes. This keeps runs repeatable from a seed. If a write fails, the run finishes and then reports the failure.
5. **Benchmarks stay files only.** They compare many short runs, and nothing reads them from the dashboard yet.
6. **One company row.** The schema supports many companies; the sim uses one, "Contracting.Bid".
7. **Driver:** `pg` (node-postgres), the standard Postgres client. It is the one new runtime dependency.
