import { describe, expect, it } from "vitest";
import { ApprovalQueue, GATES } from "../src/approvals/approvals.js";

describe("ApprovalQueue", () => {
  it("creates pending requests and lists them", () => {
    const q = new ApprovalQueue();
    const r = q.request({ gate: "hire_agent", requestedBy: "president", summary: "Hire HR" });
    expect(r.status).toBe("pending");
    expect(r.autoApproved).toBe(false);
    expect(q.pending()).toHaveLength(1);
    expect(q.get(r.id)).toBe(r);
  });

  it("approves and rejects once, with who and why", () => {
    const q = new ApprovalQueue();
    const a = q.request({ gate: "submit_bid", requestedBy: "project_manager", summary: "Bid", amountUsd: 480000 });
    const b = q.request({ gate: "release_payment", requestedBy: "bookkeeper", summary: "Pay sub" });
    expect(q.decide(a.id, true, "owner").status).toBe("approved");
    expect(q.decide(b.id, false, "owner", "Work not verified").reason).toBe("Work not verified");
    expect(() => q.decide(a.id, false, "owner")).toThrow(/already/);
    expect(() => q.decide(99, true, "owner")).toThrow(/No approval/);
    expect(q.pending()).toHaveLength(0);
    expect(q.all()).toHaveLength(2);
  });

  it("auto-approves configured gates but flags them", () => {
    const q = new ApprovalQueue(new Set(["hire_agent"]));
    const r = q.request({ gate: "hire_agent", requestedBy: "hr", summary: "Hire PM" });
    expect(r.status).toBe("approved");
    expect(r.autoApproved).toBe(true);
    expect(r.decidedBy).toBe("auto");
  });

  it("rejects negative amounts", () => {
    expect(() => new ApprovalQueue().request({ gate: "submit_bid", requestedBy: "pm", summary: "x", amountUsd: -1 })).toThrow();
  });

  it("covers all eight gates from the spec", () => {
    expect(GATES).toHaveLength(8);
  });
});
