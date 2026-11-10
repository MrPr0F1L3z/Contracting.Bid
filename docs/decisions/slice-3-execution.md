# Slice 3: execution with injected problems — decisions for owner review

Status: merged under the owner's standing routine (2026-11-10). Each item below is a decision made while building the slice. Mark any you want changed, and the change goes into the next slice.

## Decided by the owner (earlier)

| Decision | Source |
| --- | --- |
| A human approves contracts, sub agreements and anything that commits money | Owner, accountability decision |
| Each run injects real-world problems picked from a logged seed | Owner, world simulator decision |

## Made during the build (please review)

1. **New command `pnpm sim job`.** It runs the bid, then the job when the bid wins. `--force-award` awards a responsive bid that lost on price, so execution can be tested without hunting for a winning seed. The report marks a forced award.
2. **Owner gates in execution.** The gates are: the prime contract, all subcontracts together (one approval, not one per sub), the Scheduler hire, and each change-order price before the contracting officer sees it. *Alternative:* one approval per subcontract.
3. **The PM handles every site problem.** Problems go to the PM on Opus, not to the President. There is no escalation path to the President yet.
4. **Problems are menus, except scope changes.** Late delivery, weather, a sub no-show, double-booked crews and a failed inspection each give two priced options: pay to keep the schedule, or take the delay. Change orders and hidden conditions are priced by the PM and judged by the contracting officer. The true cost is hidden.
5. **Contracting officer rule.** It accepts up to 10% over cost plus 15%, and up to half again the true days. After three rejected prices the work goes ahead under dispute: the company pays, with no extra money or time. A price you reject does not count as a try.
6. **No decision means the slowest option.** If the PM never resolves a problem, the site waits. That is the slowest choice, or a dispute for a scope change. The report logs `problem_unresolved`.
7. **Liquidated damages** are 0.2% of the contract price per working day late, minimum $250 a day. Contract time comes from each stub job's "About N weeks/months" line. The planned schedule uses 90% of it, leaving 10% float.
8. **The schedule is a straight sequence.** Trades run one after another, in an order the Scheduler picks. A fixed trade ranking (`TRADE_RANK`) rejects impossible orders. Trades cannot run in parallel yet, so complex jobs look slower than they would really be. *Alternative:* allow parallel trades with predecessor links.
9. **A sub no-show replacement is the next-cheapest quote from bidding,** or 115% of the original price if there is none. If that quote is cheaper, the replacement costs nothing extra.
10. **Scripted runs react to each request** (`ReactiveProvider`), because the seed decides which problems appear. The earlier slices keep their fixed scripts.
11. **Problems for later phases** (`late-payment`) are drawn and logged but act in slice 4.

## Results

- 297 unit and functional tests pass with scripted models (47 new).
- In scripted runs of STUB-E02 over 12 seeds, profit ranged from -$18k to +$21k. The scripted PM always takes the first option and bids a fixed price, so a real PM should do better.
- Not yet run against real models. To try one: `pnpm sim job --job STUB-E02 --force-award` (about eight approvals), or add `--auto-approve` to run unattended.

## Open questions for the owner

- Should one approval cover all subcontracts, or should each be approved on its own?
- Should the PM escalate costly problems to the President, for example above a dollar threshold?
- Should trades be able to run in parallel?
