# Architecture

The full POC spec lives in the project's Claude Doc, "Contracting.Bid POC: Process map and spec". This file covers how the code is laid out.

## Decisions

- Paperclip AI is a design reference, not a fork. We borrow its ideas: hires as config records, heartbeats, budgets with hard stops, approval gates, and versioned agent config.
- TypeScript on Node.js 22, tested with Vitest.
- Claude (`claude-opus-5-5`) runs the President and Project Manager. One local model on vLLM runs every other role and the simulated counterparties. With 24GB of VRAM, only one local model fits at a time.
- Everything runs on the owner's machine with Docker Compose. CI and cloud sessions only use stub models and saved fixtures.
- The company is a general contractor that subcontracts all work. Jobs are seeded from real SAM.gov construction solicitations, read-only. Nothing is ever submitted to SAM.gov.

## Layout

| Path | What it does |
| --- | --- |
| `src/models/` | Provider-neutral model types, the Claude and vLLM providers, a scripted stub, record/replay wrappers, and the role router |
| `src/config/` | Environment config and the role list: who reports to whom, and which model family runs each role |
| `src/sim/` | Seeded RNG, the simulated clock, and the problem catalog |
| `src/events/` | Append-only event log (in-memory now, Postgres next) |
| `src/budget/` | Per-call cost and budgets that warn at 80% and stop at 100% |
| `src/approvals/` | The eight owner approval gates and the approval queue |
| `src/samgov/` | Read-only SAM.gov search client, the seeded opportunity picker, and the listing cache |
| `src/gpu/` | Pauses the owner's listed GPU processes before a run and always resumes them afterwards |
| `db/migrations/` | Postgres schema for the data model |
| `test/` | Unit tests for every function, plus functional tests that apply the schema to an embedded Postgres |

## Determinism and replay

Every random choice goes through `SeededRng`, and each concern forks its own stream (`rng.fork("problems")`), so a new random draw in one place never shifts another. Agents wake on `SimClock` ticks, never on wall-clock time. `RecordingProvider` saves every model response, and `ReplayProvider` serves them back, so a replay matches exactly even when a local model is not deterministic.

## Next (step 4)

1. Postgres-backed event log and repositories.
2. The agent runtime: heartbeats, task checkout, role tools, and the hiring chain (President, then HR, then PM).
3. The world simulator's counterparties and problem injection.
4. The owner dashboard for approvals and the run log.
