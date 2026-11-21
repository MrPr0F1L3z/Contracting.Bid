# SAM.gov job feed (2026-11-21)

The owner asked for the SAM.gov integration as the next slice. Runs can now bid real, current federal construction solicitations read from SAM.gov, instead of only the made-up stub jobs. How-to: [README, Real jobs from SAM.gov](../../README.md#real-jobs-from-samgov).

## What changed

- `src/opportunities/samgov.ts`: a read-only client for the Get Opportunities Public API (v2). It searches solicitations (`ptype=o`) and combined synopses (`k`) posted in the last `SAMGOV_LOOKBACK_DAYS`, keeps active ones under construction NAICS codes (236, 237, 238), and maps each to the existing `Opportunity` shape. It reads a notice's description only for the job a run picks.
- `src/opportunities/cache.ts`: listings are cached in a new `listing_cache` table (migration 005), or in `data/samgov-listings.json` without a database, and read again at most every `SAMGOV_CACHE_HOURS` (default 24).
- `src/world/scope.ts`: the simulated world can now run any listing, not only the six stub jobs (see item 3).
- `JOB_SOURCE=stub|samgov` (default `stub`) and a `--source` flag on `bid`, `job` and `closeout`. `pnpm sim listings [--refresh]` shows what a run can bid.
- The always-on dashboard offers the SAM.gov jobs in Start a run when `JOB_SOURCE=samgov`. The workspace shows each run's agency from the run itself.

## Made while building (please review)

1. **Read-only, still sandboxed.** Nothing is submitted to SAM.gov or sent to a contracting officer. The real listing only replaces the made-up job; the subcontractors, competitors, award, site problems and money are still simulated. This keeps the PoC rule (no real-world interaction) while using real jobs.
2. **The stub stays the default, and scripted runs always use it.** Tests and CI never call SAM.gov. `--stub` runs still bid only STUB-E02, because the scripted models only know that job. *Question:* should staging (the promotion gate's 10 unattended runs) use `JOB_SOURCE=samgov`, or stay on the stub jobs? -- Staging uses SAM.gov, as a quick setting change; prod only ever sees SAM.gov data.
   **Done (2026-11-21):** `JOB_SOURCE=samgov` in `deploy/stacks/staging.env` (one line to change back). Prod always uses SAM.gov: it refuses any other source, never shows the stub jobs, and its deploy checks it can read listings. See [docs/STACKS.md](../STACKS.md#where-stagings-jobs-come-from).
3. **The world guesses the scope of a real job.** A real notice doesn't list its trades and often states no value. The world infers trades and cost shares from the NAICS code and trade words in the title and description, sets complexity from the trade count (six or more, or new construction, is complex), and draws a hidden value and contract time from the seed within the complexity's band. The agents see only the notice, as before. The guess is rough; for example a 236 building job that names no trades gets a generic nine-trade mix.
4. **Rate limits shape the design.** SAM.gov limits requests per key per day (the docs don't give numbers; a plain account is known to get very few). So a refresh is 2 requests (or 2 per code in `SAMGOV_NAICS`), one page each by default, and listings are cached for a day. A run reads one description, once, and keeps it in the cache. If SAM.gov fails or is over the limit, the cached listings are used and the run says so; if a description can't be read, the job is bid from its title.
5. **Replays.** Each run keeps a full copy of the listing it bid in its `opportunity_found` event, since listings change and drop off SAM.gov. `--job ID --seed N` replays a run while the listing is still in the cache; replaying one that has dropped out of the cache isn't built yet.
6. **The dashboard reads listings when it starts.** Start a run offers the jobs read at service start; restart the service for new ones. If `JOB_SOURCE=samgov` is set up wrong, the service still starts and offers no jobs, with the reason in its log.
7. **Not in scope:** the customer site (`web/`) still uses its own stub listing provider, and prod still runs no sims. Feeding prod from real SAM.gov use is the next step for prod.
8. **Untested against the live API here.** This environment can't reach api.sam.gov, so the client is built from the published API docs and tested against a made-up fixture. Two details in the docs are unclear: whether `offset` counts pages or records (we treat it as a page index, and only one page is read by default), and how the description endpoint takes the key (we send `api_key`, as the search does). The first `pnpm sim listings` on your machine is the real test.

## You need to do

- Get a SAM.gov public API key: sign in at sam.gov, open Account Details, enter your password, and copy the Public API Key.
- Put it in `.env` as `SAM_GOV_API_KEY`, set `JOB_SOURCE=samgov`, and run `pnpm sim listings`.
