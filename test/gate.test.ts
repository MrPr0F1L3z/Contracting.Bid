import { describe, expect, it } from "vitest";
import { main as simMain } from "../src/cli/sim.js";
import { ensureCompany } from "../src/db/stores.js";
import { DEFAULT_MIN_UNATTENDED_RUNS, disqualification, evaluateGate, gateRuns, minUnattendedRuns, unattendedRule, type GateRun } from "../src/deploy/gate.js";
import { MIGRATIONS, migratedDb } from "./helpers/pgliteDb.js";

const approval = (over: Partial<GateRun["approvals"][number]> = {}) => ({ status: "approved", autoApproved: true, items: null, approvedItems: null, ...over });
const run = (over: Partial<GateRun> = {}): GateRun => ({ runId: "r", command: "closeout", outcome: "closed", modelConfig: {}, approvals: [approval()], ...over });

describe("promotion gate: runs without human intervention", () => {
  it("counts only real closeout runs that closed", () => {
    expect(disqualification(run(), "no-owner-decisions")).toBeNull();
    expect(disqualification(run({ command: "job" }), "no-owner-decisions")).toBe("not a full closeout run");
    expect(disqualification(run({ outcome: "interrupted" }), "no-owner-decisions")).toBe("ended interrupted, not closed");
    expect(disqualification(run({ outcome: null }), "approvals-only")).toBe("ended unfinished, not closed");
    expect(disqualification(run({ modelConfig: { stub: true, autoApprove: true } }), "no-owner-decisions")).toBe("used scripted models");
  });

  it("no-owner-decisions: any decision by the owner disqualifies, --auto-approve does not", () => {
    const owner = approval({ autoApproved: false });
    expect(disqualification(run({ approvals: [approval(), owner] }), "no-owner-decisions")).toBe("the owner decided an approval");
    expect(disqualification(run({ approvals: [owner], modelConfig: { autoApprove: true } }), "no-owner-decisions")).toBeNull();
    expect(disqualification(run({ approvals: [] }), "no-owner-decisions")).toBeNull();
  });

  it("approvals-only: clicking Approve is fine, rejecting or approving part of a batch is not", () => {
    expect(disqualification(run({ approvals: [approval({ autoApproved: false })] }), "approvals-only")).toBeNull();
    expect(disqualification(run({ approvals: [approval({ status: "rejected", autoApproved: false })] }), "approvals-only")).toBe("the owner rejected an approval");
    expect(disqualification(run({ approvals: [approval({ autoApproved: false, items: [{}, {}], approvedItems: ["a"] })] }), "approvals-only")).toBe("the owner approved only part of a batch");
    expect(disqualification(run({ approvals: [approval({ autoApproved: false, items: [{}, {}], approvedItems: ["a", "b"] })] }), "approvals-only")).toBeNull();
  });

  it("passes once enough runs count", () => {
    const runs = [run({ runId: "a" }), run({ runId: "b", outcome: "lost" }), run({ runId: "c" })];
    expect(evaluateGate(runs, "no-owner-decisions", 2)).toEqual({ counted: 2, needed: 2, passed: true, runIds: ["a", "c"] });
    expect(evaluateGate(runs, "no-owner-decisions", 3)).toMatchObject({ counted: 2, passed: false });
    expect(evaluateGate([], "approvals-only", 0)).toMatchObject({ counted: 0, passed: true });
  });

  it("reads its settings", () => {
    expect(minUnattendedRuns(undefined)).toBe(DEFAULT_MIN_UNATTENDED_RUNS);
    expect(DEFAULT_MIN_UNATTENDED_RUNS).toBe(10);
    expect(minUnattendedRuns("0")).toBe(0);
    expect(minUnattendedRuns(" 4 ")).toBe(4);
    for (const bad of ["-1", "2.5", "ten"]) expect(() => minUnattendedRuns(bad)).toThrow(/PROMOTE_MIN_RUNS/);
    expect(unattendedRule("")).toBe("no-owner-decisions");
    expect(unattendedRule("approvals-only")).toBe("approvals-only");
    expect(() => unattendedRule("loose")).toThrow(/PROMOTE_RUN_RULE/);
  });

  it("reads runs and approvals from the database (functional, embedded Postgres)", async () => {
    const db = await migratedDb();
    const lines: string[] = [];
    // A stub run, saved the way a real one is: it never counts.
    expect(await simMain(["closeout", "--stub", "--seed", "1"], { out: (l) => void lines.push(l), env: { MIGRATIONS_DIR: MIGRATIONS }, db, writeReport: async () => undefined })).toBe(0);
    const company = await ensureCompany(db);
    const add = async (id: string, outcome: string, config: Record<string, unknown>, approvals: Array<[string, boolean]>) => {
      await db.query("INSERT INTO runs (id, company_id, seed, scenario_version, model_config, command, outcome) VALUES ($1, $2, 1, 'v1', $3, 'closeout', $4)", [id, company, JSON.stringify(config), outcome]);
      let n = 1;
      for (const [status, auto] of approvals) {
        await db.query("INSERT INTO approvals (run_id, approval_no, gate, requested_by, summary, status, auto_approved) VALUES ($1, $2, 'bid', 'pm', 's', $3, $4)", [id, n++, status, auto]);
      }
    };
    await add("real-auto", "closed", { autoApprove: true }, [["approved", false]]);
    await add("real-owner", "closed", {}, [["approved", true], ["approved", false]]);
    await add("real-lost", "lost", { autoApprove: true }, []);
    const runs = await gateRuns(db);
    expect(runs).toHaveLength(4);
    expect(runs.find((r) => r.runId === "real-owner")!.approvals).toHaveLength(2);
    expect(evaluateGate(runs, "no-owner-decisions", 10)).toMatchObject({ counted: 1, runIds: ["real-auto"], passed: false });
    expect(evaluateGate(runs, "approvals-only", 2)).toMatchObject({ counted: 2, passed: true });
    await db.close();
  }, 30_000);

  it("finds nothing in an empty database", async () => {
    const db = await migratedDb();
    expect(await gateRuns(db)).toEqual([]);
    await db.close();
  }, 30_000);
});
