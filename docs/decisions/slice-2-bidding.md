# Slice 2: bid and award — decisions for owner review

Status: merged under the owner's standing routine (2026-11-10). Each item below is a decision made while building the slice. Mark any you want changed, and the change goes into the next slice.

## Decided by the owner (earlier)

| Decision | Source |
| --- | --- |
| A human approves anything that commits money or a legal obligation, including bids | Owner, accountability decision |
| Sam.gov stub jobs, easy to complex, no value cap | Owner |
| Each run's problems come from a logged seed, so any run can be replayed | Owner |

## Made during the build (please review)

1. **Four owner gates in a bid run.** Pursuing the job, hiring the Estimator, hiring Procurement, and the bid price each wait for you. `--auto-approve` approves all of them for unattended simulations, and the report records them as auto-approved by you. *Alternative:* make the bid-team hires automatic like the first two.
2. **The President decides go/no-go; the PM sets the price.** Both run on Opus. The Estimator and Procurement run on the worker model.
3. **The bid team is hired when the first job is pursued,** not up front. HR gets a written request from the President naming both roles, as in slice 1.
4. **The market is simulated, not agent-played.** Subcontractor quotes, competitors and the contracting officer are seeded formulas, not model calls. This keeps runs cheap and exactly replayable. *Alternative:* let models play the subs and the contracting officer in a later slice.
5. **Award rule is lowest price technically acceptable.** A bid is not responsive if any trade the job really needs has no selected quote. Trades the Estimator adds that the job doesn't need are allowed; they only raise the price.
6. **The hidden scope is fixed per stub job** (`JOB_SCOPES`), and the agents must work it out from the scope text. The real Sam.gov integration will need a different source of truth for grading responsiveness.
7. **A bid below the selected quotes is allowed,** but the report shows the margin and the terminal flags "BELOW COST". The scripted dry run bids a fixed $105,000, so at some seeds it wins below cost. *Question:* should the PM's tool refuse a bid below cost, or should the owner gate catch it?
8. **Only `quote-expired` acts in this slice.** The other problems the seed draws are logged in the report and act in slice 3 (execution) and slice 4 (closeout). When it fires, the first selected quote in one required trade comes back 8–15% higher, and Procurement is told so it can choose another.
9. **One job per run.** The run ends at the award decision. Slice 3 picks up the awarded job.
10. **Step limit for Procurement scales with the job:** three tool calls per estimated trade plus four, so a nine-trade complex job gets 31 steps.

## Results

- 250 unit and functional tests pass with scripted models (56 new).
- The scripted run on STUB-E02 wins at seed 1, loses at seed 2, and hits `quote-expired` on flooring at seed 9.
- Not yet run against real models. To try one: `pnpm sim bid --job STUB-E02` (about four approvals), or `pnpm sim bid --auto-approve --complexity moderate`.

## Open questions for the owner

- Should a bid below cost be blocked outright?
- Should the bid-team hires (Estimator, Procurement) become automatic, like the first two?
