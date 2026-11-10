# Owner rules from the slice reviews (2026-11-10)

The owner answered the open questions in the slice 2-4 notes. These rules are now enforced in the tools, not just in the prompts.

| Rule (owner's words) | What changed |
| --- | --- |
| "We should never take a job at a loss." | `submit_bid` refuses a price below the total of the selected quotes, and refuses to bid with no quotes selected, before the owner is asked. A refusal is logged as `bid_refused`. The PM's brief and bid package state the rule. |
| "Approvals in some cases will cover everything, but in some cases will need fine grain control. Prepare for either case." | A batch approval (`sign_commitment` for subcontracts, `release_payment` for bills) lists each item. The owner can approve the whole batch, or only some items. Subcontracts and bills left out stay open, and the agent can ask again for them. In the terminal: `y` approves all, `i` picks items one by one. |
| "Final invoices will always need approval." | New gate `submit_invoice`. The Bookkeeper's final invoice goes to the owner before the contracting officer. |

## Made while building (please review)

1. **The floor is cost, not cost plus a margin.** A bid equal to the selected quotes is allowed. It breaks even on subcontracts but not on overhead. *Question:* should there be a minimum markup, for example 5%?
2. **Losses after the award can still happen.** Site problems, liquidated damages and disputes can push a job below cost. The rule applies when the bid is set, which is the only point where the company chooses the price.
3. **Item choice belongs to whoever approves.** The same request supports both modes, so the dashboard can offer "approve all" and "choose items" on the same card.
4. **The scripted PM now prices at the selected quotes plus 12%,** instead of a fixed $105,000. Seed outcomes in scripted runs may differ from earlier slices.
