# Slice 1: hiring chain — decisions for owner review

Status: merged under the owner's standing routine (2026-11-10). Each item below is a decision made while building the slice. Mark any you want changed, and the change goes into the next slice.

## Decided by the owner

| Decision | Source |
| --- | --- |
| President → HR and HR → Project Manager are automatic, with no owner approval | Owner, 2026-11-10 |
| Every role runs on cloud models by default: Opus 5.5 for the President and PM, a cheaper Claude model for the rest | Owner, after benchmarking hybrid against cloud |
| A cheaper model handles roles that are neither executive nor reasoning-heavy | Owner, 2026-11-10 |

## Made during the build (please review)

1. **Who may hire whom.** The President may hire only HR. HR may hire every role except President and HR. No other role can hire. *Alternative:* let the President hire any role directly.
2. **One agent per role.** A role with an active or pending agent cannot be hired again. Two PMs for two concurrent jobs would need this lifted. *Alternative:* allow several agents per role, each with a scope.
3. **Manager comes from the org chart, not from the hirer.** HR hires the PM, but the PM reports to the President, following `REPORTS_TO`.
4. **Hire budgets are capped at $2 per agent.** Each agent's model spend is also capped by its own budget, as well as the $5 run budget. The President is appointed with $2.
5. **Later hires ask the owner in the terminal.** `y` approves, and any other answer rejects, with your text recorded as the reason. A rejected hire goes back to the agent as a tool error so it can revise and retry. In a benchmark, every hire beyond the two automatic ones is declined, so runs stay comparable.
6. **HR gets a written request from the President.** In the first real run, the local model claimed "the President has approved this role in writing" when no such approval existed. HR's own instructions require one, so HR now receives an actual written request with the business need and budget. *Lesson for later slices:* when an agent's instructions require evidence, the evidence has to be put in front of it.
7. **Claude's thinking is sent back unchanged** in every tool loop, as the API requires.
8. **Default worker model is Sonnet 5.5** (`CLAUDE_WORKER_MODEL`). Haiku 5.5 is about 1/40 the cost of Opus. It works too, but it doesn't accept server-side refusal fallbacks, so the provider leaves them off for it.
9. **The local GPU path stays available** as `--models hybrid`, with the vLLM lane check and a semaphore limiting local calls to 2 at a time. It is no longer the default.
10. **Records live in memory for now.** Agents, approvals and events are written to the run report JSON, not to Postgres. Persistence is planned for a later slice.

## Results

- First real hybrid run: complete, $0.04 of Claude spend, 3 agents.
- Benchmark: cloud was clearly faster (owner's run). Cloud is now the default.
- 194 unit and functional tests pass in CI.

## Open questions for the owner

- Should HR be able to hire more than one agent per role later, for example a PM per job?
- Is $2 per agent the right cap once agents run whole jobs?
