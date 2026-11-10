# Fixes from the first real closeout runs (2026-11-10)

The owner ran `pnpm sim closeout --job STUB-E02 --force-award --auto-approve` on cloud models. Two runs ended INCOMPLETE.

| Run | What went wrong | Fix |
| --- | --- | --- |
| Seed 2082671124 | HR sent the President a plan instead of hiring a PM. The President's instructions told HR to wait for approval, and HR cannot get a reply. | The President's written request is HR's approval (PR #6). |
| Seed 1523336618 | The PM never priced the government's change order. Its brief gave the size only as "about 9%" of the subcontract, so it replied asking for figures. The change went ahead under dispute and the company paid the $4,800 itself. | The brief now gives the subcontractor's quote for the added work (price and days). The PM's system prompt says each task is its only chance to act, and must end with its tool. |
| Seed 1523336618 | The Bookkeeper left the $4,800 bill for the disputed change unpaid, so the project could not close. | The brief says every bill goes in a payment run: we owe the sub for directed work whatever happens with the government. The Bookkeeper must not hold a bill itself; the owner can hold one at approval. |

## Made while fixing (please review)

1. **The PM now sees the sub's price for a change.** Before, the true cost was hidden and the PM had to estimate it. A real GC prices a change from its sub's quote, so this is more realistic. The contracting officer still refuses a price more than 26.5% over cost.
2. **Holding a bill is the owner's call only.** The Bookkeeper can no longer decide by itself to hold back a sub's pay. You can still hold any bill when you approve a payment run (`i` in the terminal, or "Approve checked only" on the dashboard).

## Not a bug

The bid lost: $100,400 against a low bid of $89,300, at a 17% markup. It was awarded only because of `--force-award`. *Question:* should the PM aim for a leaner markup on LPTA jobs?
