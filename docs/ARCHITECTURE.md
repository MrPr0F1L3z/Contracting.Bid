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
| `src/events/` | Append-only event log (in-memory now, Postgres next) |
| `src/budget/` | Per-call cost and budgets that warn at 80% and stop at 100% |
| `src/approvals/` | The eight owner approval gates and the approval queue |
| `src/opportunities/` | The `OpportunitySource` interface, the stub source of made-up solicitations (two each at easy, moderate and complex), the seeded picker, and a coverage planner that spreads runs across complexity levels |
| `src/agents/` | Agent records and the hiring policy, the agent tool loop (budgets, event logging, Claude's thinking passed back unchanged), and the hiring tools |
| `src/gpu/` | Pauses the owner's listed GPU processes before a run and always resumes them afterwards; checks vLLM lanes and speed and restarts it when needed |
| `src/cli/` | `pnpm gpu` (vLLM check, ensure, load test) and `pnpm sim hiring` |
| `db/migrations/` | Postgres schema for the data model |
| `test/` | Unit tests for every function, plus functional tests that apply the schema to an embedded Postgres |

## Determinism and replay

Every random choice goes through `SeededRng`, and each concern forks its own stream (`rng.fork("problems")`), so a new random draw in one place never shifts another. Agents wake on `SimClock` ticks, never on wall-clock time. `RecordingProvider` saves every model response, and `ReplayProvider` serves them back, so a replay matches exactly even when a local model is not deterministic.

## Hiring (slice 1)

The owner appoints the President. The President hires HR with `propose_hire`, writing HR's standing instructions; HR then hires the Project Manager the same way. These two hires are automatic by the owner's rule (`INITIAL_HIRES`): they are recorded as approvals flagged `autoApproved` but never wait on the owner. Any other hire waits for the owner's answer. `hirePolicy` lets the President hire only HR and lets HR hire every other role; a hire's manager comes from the org chart (`REPORTS_TO`), so the PM reports to the President even though HR hired it.

Each agent task runs in `runAgentTask`: call the model, run the tools it asks for, return all results in one message, and repeat until it stops calling tools. Every model call is charged to both the run budget and the agent's own budget, and the loop stops before a call once either is spent. Calls to the local model share a semaphore sized to `VLLM_MAX_LANES`, so extra calls wait in our code instead of queueing inside vLLM.

## Next

1. Postgres-backed event log and agent records.
2. Slice 2: bid and award (pursue decision, estimate, vendor quotes, bid submission), with the world simulator's contracting officer and vendors.
3. Slice 3: execution with injected problems. Slice 4: closeout and AR/AP.
4. The owner dashboard for approvals and the run log.
