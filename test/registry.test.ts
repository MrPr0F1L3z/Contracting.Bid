import { describe, expect, it } from "vitest";
import { AgentRegistry, INITIAL_HIRES, hirePolicy, isInitialHire } from "../src/agents/registry.js";
import { ROLES } from "../src/config/roles.js";

const INSTR = "Run the hiring pipeline for the company.";

describe("hirePolicy", () => {
  it("lets the President hire only HR", () => {
    expect(hirePolicy("president", "hr").allowed).toBe(true);
    expect(hirePolicy("president", "project_manager")).toMatchObject({ allowed: false });
  });
  it("lets HR hire every role except President and HR", () => {
    for (const role of ROLES) {
      expect(hirePolicy("hr", role).allowed).toBe(role !== "president" && role !== "hr");
    }
  });
  it("stops other roles hiring, and anyone hiring a President", () => {
    expect(hirePolicy("project_manager", "estimator")).toEqual({ allowed: false, reason: "The project_manager role cannot hire." });
    expect(hirePolicy("president", "president").allowed).toBe(false);
  });
});

describe("isInitialHire", () => {
  it("is true only for President→HR and HR→PM", () => {
    expect(INITIAL_HIRES).toHaveLength(2);
    expect(isInitialHire("president", "hr")).toBe(true);
    expect(isInitialHire("hr", "project_manager")).toBe(true);
    expect(isInitialHire("hr", "estimator")).toBe(false);
    expect(isInitialHire("president", "project_manager")).toBe(false);
  });
});

describe("AgentRegistry", () => {
  function withHr() {
    const reg = new AgentRegistry();
    const pres = reg.appointPresident("Lead the company.", 3);
    const hr = reg.propose({ hirerId: pres.id, role: "hr", instructions: INSTR, budgetUsd: 0.5 });
    reg.activate(hr.id, 1);
    return { reg, pres, hr };
  }

  it("appoints one President who reports to the owner", () => {
    const reg = new AgentRegistry();
    expect(reg.appointPresident("Lead.", 3)).toMatchObject({ id: 1, role: "president", managerId: null, hiredById: null, status: "active" });
    expect(() => reg.appointPresident("Again.", 3)).toThrow("already exists");
  });

  it("records a proposed hire as pending, with the manager from the org chart", () => {
    const { reg, pres, hr } = withHr();
    expect(reg.get(hr.id)).toMatchObject({ role: "hr", managerId: pres.id, hiredById: pres.id, status: "active", approvalId: 1 });
    const pm = reg.propose({ hirerId: hr.id, role: "project_manager", instructions: "  Manage awarded jobs.  ", budgetUsd: 1 });
    // HR hires the PM, but the PM reports to the President.
    expect(pm).toMatchObject({ status: "pending_approval", managerId: pres.id, hiredById: hr.id, instructions: "Manage awarded jobs." });
  });

  it("refuses hires that break the policy, duplicate a role or lack a manager", () => {
    const { reg, pres, hr } = withHr();
    expect(() => reg.propose({ hirerId: pres.id, role: "estimator", instructions: INSTR, budgetUsd: 1 })).toThrow("HR runs hiring");
    expect(() => reg.propose({ hirerId: pres.id, role: "hr", instructions: INSTR, budgetUsd: 1 })).toThrow("already on staff");
    expect(() => reg.propose({ hirerId: hr.id, role: "estimator", instructions: INSTR, budgetUsd: 1 })).toThrow("reports to the project_manager");
    const pm = reg.propose({ hirerId: hr.id, role: "project_manager", instructions: INSTR, budgetUsd: 1 });
    expect(() => reg.propose({ hirerId: hr.id, role: "project_manager", instructions: INSTR, budgetUsd: 1 })).toThrow("pending approval");
    expect(() => reg.propose({ hirerId: pm.id, role: "estimator", instructions: INSTR, budgetUsd: 1 })).toThrow("not an active agent");
    expect(() => reg.propose({ hirerId: 99, role: "estimator", instructions: INSTR, budgetUsd: 1 })).toThrow("not an active agent");
  });

  it("validates budget and instructions", () => {
    const { reg, hr } = withHr();
    expect(() => reg.propose({ hirerId: hr.id, role: "bookkeeper", instructions: INSTR, budgetUsd: 0 })).toThrow("positive");
    expect(() => reg.propose({ hirerId: hr.id, role: "bookkeeper", instructions: "   ", budgetUsd: 1 })).toThrow("required");
  });

  it("lets a rejected role be proposed again, and settles each proposal once", () => {
    const { reg, hr } = withHr();
    const first = reg.propose({ hirerId: hr.id, role: "bookkeeper", instructions: INSTR, budgetUsd: 1 });
    expect(reg.reject(first.id).status).toBe("rejected");
    expect(() => reg.activate(first.id)).toThrow("not pending");
    expect(() => reg.activate(99)).toThrow("No agent 99");
    const second = reg.propose({ hirerId: hr.id, role: "bookkeeper", instructions: INSTR, budgetUsd: 1 });
    expect(reg.activate(second.id).status).toBe("active");
    expect(reg.byRole("bookkeeper")?.id).toBe(second.id);
  });

  it("returns copies, so callers cannot change records", () => {
    const { reg, hr } = withHr();
    const copy = reg.get(hr.id)!;
    copy.status = "rejected";
    reg.all()[0]!.budgetUsd = 999;
    expect(reg.get(hr.id)?.status).toBe("active");
    expect(reg.get(1)?.budgetUsd).toBe(3);
  });
});
