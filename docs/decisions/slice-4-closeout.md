# Slice 4: closeout, AR and AP — decisions for owner review

Status: merged under the owner's standing routine (2026-11-10). This is the last planned slice of the sandboxed POC. Each item below is a decision made while building the slice. Mark any you want changed.

## Decided by the owner (earlier)

| Decision | Source |
| --- | --- |
| A human approves payments and closing the project | Owner, accountability decision |
| The PoC covers hiring through managing and closing out the first awarded project | Owner, PoC scope |

## Made during the build (please review)

1. **New command `pnpm sim closeout`.** It runs the whole lifecycle, from the first hire to a closed job, in one run. It takes the same flags as `job`.
2. **Owner gates in closeout:**
   - the Bookkeeper hire
   - each payment run (all the bills the Bookkeeper pays in one call need one approval)
   - closing the project

   *Alternative:* one approval per bill.
3. **Invoicing is not an owner gate.** It asks for money but does not commit any, so the Bookkeeper sends it directly. *Question:* a federal invoice is a certified claim, so should you approve it?
4. **One final invoice, no progress billing.** It must equal the contract price plus approved change orders, less liquidated damages. The contracting officer returns any other amount, and each returned invoice delays payment by 10 days. Monthly progress billing and retainage are not modeled.
5. **Bills come from the job.** There is one bill per subcontract. Each problem that cost money adds one more: a vendor bill for expediting or overtime, or a bill from the trade's subcontractor for change work. The bills add up to the job's cost from slice 3.
6. **`late-payment` means late and short.** The government pays 15–45 days late and holds back 2–5% pending closeout documents. The Bookkeeper decides two things:
   - whether to claim Prompt Payment Act interest, at a simplified 5% a year
   - whether to submit the closeout documents to release the amount held back

   Anything the Bookkeeper leaves open is written off.
7. **Subs are paid in full at closeout,** whether or not the government has paid yet. Pay-when-paid terms, cash flow timing and lien waivers are not modeled.
8. **The PM closes the job,** and the close tool refuses while the invoice, any bill or any receivable is still open.
9. **Each slice now builds on the one before it** through stage functions (`bidStage`, `jobStage`). Every command still writes one self-contained report.

## Results

- 323 unit and functional tests pass with scripted models (26 new).
- Scripted runs on STUB-E02 close at every seed tried. When the late payment fires, interest raises the cash profit slightly above the job profit.
- Not yet run against real models. To try the whole lifecycle: `pnpm sim closeout --job STUB-E02 --force-award` (about 11 approvals), or add `--auto-approve` to run it unattended.

## Open questions for the owner

- Should the final invoice be an owner gate?
- Should payment runs be approved per bill, and should subs be paid only after the government pays (pay-when-paid)?
- What's next after the sandboxed POC? The plan has Postgres persistence, the real SAM.gov feed and the owner dashboard.
