import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals/approvals.js";
import {
  bidDetails, changeOrderDetails, closeDetails, contractDetails, formatDeadline, hireDetails, notes, opportunityFacts, pursueDetails, usd, valueRange,
} from "../src/approvals/details.js";
import type { Opportunity } from "../src/opportunities/types.js";

const job: Opportunity = {
  noticeId: "STUB-X01",
  title: "Roof replacement, maintenance building",
  agency: "General Services Administration",
  naicsCode: "238160",
  type: "combined_synopsis_solicitation",
  active: true,
  responseDeadline: "2026-12-04T19:00:00Z",
  setAside: "Total Small Business",
  placeOfPerformance: { city: "Denver", state: "CO" },
  scopeSummary: "Remove and replace 12,000 sq ft of membrane roof.",
  estimatedValueUsd: { min: 250000, max: 500000 },
  complexity: "moderate",
};
const fact = (d: { facts: { label: string; value: string }[] }, label: string) => d.facts.find((f) => f.label === label)?.value;

describe("formatting", () => {
  it("usd rounds and groups", () => {
    expect(usd(1234567.6)).toBe("$1,234,568");
    expect(usd(0)).toBe("$0");
  });

  it("formatDeadline is always UTC and passes bad input through", () => {
    expect(formatDeadline("2026-12-04T19:00:00Z")).toBe("Dec 4, 2026, 7:00 PM UTC");
    expect(formatDeadline("2026-12-04T23:30:00-05:00")).toBe("Dec 5, 2026, 4:30 AM UTC");
    expect(formatDeadline("soon")).toBe("soon");
  });

  it("valueRange handles a range, a single figure and none", () => {
    expect(valueRange({ min: 250000, max: 500000 })).toBe("$250,000 to $500,000");
    expect(valueRange({ min: 100000, max: 100000 })).toBe("$100,000");
    expect(valueRange(null)).toBe("Not stated");
  });

  it("notes keeps only non-empty strings, trimmed, and is undefined when none remain", () => {
    expect(notes(["A", "  text  "], ["B", ""], ["C", "   "], ["D", undefined], ["E", 42])).toEqual([{ label: "A", text: "text" }]);
    expect(notes(["A", ""], ["B", null])).toBeUndefined();
    expect(notes()).toBeUndefined();
  });
});

describe("opportunityFacts", () => {
  it("lists what the owner needs to judge a project", () => {
    expect(opportunityFacts(job)).toEqual([
      { label: "Location", value: "Denver, CO" },
      { label: "Government estimate", value: "$250,000 to $500,000" },
      { label: "Response due", value: "Dec 4, 2026, 7:00 PM UTC" },
      { label: "Set-aside", value: "Total Small Business" },
      { label: "Notice type", value: "Combined synopsis solicitation" },
      { label: "NAICS", value: "238160" },
      { label: "Complexity", value: "Moderate" },
    ]);
  });

  it("copes with no set-aside, no estimate and no complexity", () => {
    const facts = opportunityFacts({ ...job, setAside: null, estimatedValueUsd: null, complexity: null });
    expect(facts.find((f) => f.label === "Set-aside")?.value).toBe("None");
    expect(facts.find((f) => f.label === "Government estimate")?.value).toBe("Not stated");
    expect(facts.some((f) => f.label === "Complexity")).toBe(false);
  });
});

describe("details per gate", () => {
  it("pursueDetails: the project, its scope and the agent's reasoning as separate parts", () => {
    const d = pursueDetails(job, "Good fit for a small team.");
    expect(d.title).toBe("Roof replacement, maintenance building");
    expect(d.subtitle).toBe("General Services Administration · STUB-X01");
    expect(d.notes).toEqual([
      { label: "Scope", text: "Remove and replace 12,000 sq ft of membrane roof." },
      { label: "Why pursue it", text: "Good fit for a small team." },
    ]);
  });

  it("bidDetails: price, cost and margin", () => {
    const d = bidDetails(job, 400000, 340000, "Assumes daytime access.");
    expect(fact(d, "Bid price")).toBe("$400,000");
    expect(fact(d, "Selected quotes")).toBe("$340,000");
    expect(fact(d, "Margin")).toBe("$60,000 (15.0%)");
    expect(d.notes).toEqual([{ label: "Assumptions", text: "Assumes daytime access." }]);
    expect(bidDetails(job, 400000, 340000, "").notes).toBeUndefined();
    expect(fact(bidDetails(job, 0, 0, ""), "Margin")).toBe("$0 (n/a)");
  });

  it("hireDetails", () => {
    const d = hireDetails({ role: "estimator", budgetUsd: 2, hirer: "hr#2", justification: "A bid is due.", instructions: "Estimate each trade." });
    expect(d).toMatchObject({ title: "Hire estimator", subtitle: "Proposed by hr#2" });
    expect(fact(d, "Spending limit")).toBe("$2");
    expect(d.notes?.map((n) => n.label)).toEqual(["Why now", "Standing instructions"]);
  });

  it("contractDetails has facts only", () => {
    const d = contractDetails(job, 400000, 60, 500);
    expect(d.facts).toEqual([
      { label: "Contract price", value: "$400,000" },
      { label: "Time to complete", value: "60 working days" },
      { label: "Liquidated damages", value: "$500 per day late" },
    ]);
    expect(d.notes).toBeUndefined();
  });

  it("changeOrderDetails singularises one day and ignores a non-text justification", () => {
    const d = changeOrderDetails(job, 12400, 1, "Rotten decking found.", undefined);
    expect(fact(d, "Added time")).toBe("1 day");
    expect(d.notes).toEqual([{ label: "What happened", text: "Rotten decking found." }]);
    expect(fact(changeOrderDetails(job, 1, 3, "x", "y"), "Added time")).toBe("3 days");
  });

  it("closeDetails shows interest and write-offs only when there are any", () => {
    const base = { invoicedUsd: 400000, receivedUsd: 398000, paidOutUsd: 340000, cashProfitUsd: 58000, interestUsd: 0, writtenOffUsd: 0 };
    expect(closeDetails(job, base, "All bills paid.").facts.map((f) => f.label)).toEqual(["Invoiced", "Received", "Paid out", "Cash profit"]);
    const extra = closeDetails(job, { ...base, interestUsd: 120, writtenOffUsd: 2000 }, 5);
    expect(fact(extra, "Interest recovered")).toBe("$120");
    expect(fact(extra, "Written off")).toBe("$2,000");
    expect(extra.notes).toBeUndefined();
  });
});

describe("ApprovalQueue with details", () => {
  it("keeps the details on the request, pending and after a decision", () => {
    const q = new ApprovalQueue();
    const details = pursueDetails(job, "Good fit for a small team.");
    const r = q.request({ gate: "pursue_opportunity", requestedBy: "president#1", summary: "Pursue it.", details });
    expect(q.pending()[0]!.details).toEqual(details);
    expect(q.decide(r.id, true, "owner").details).toEqual(details);
  });

  it("leaves details off a request that has none", () => {
    const r = new ApprovalQueue().request({ gate: "submit_invoice", requestedBy: "bookkeeper#7", summary: "Send it." });
    expect("details" in r).toBe(false);
  });
});
