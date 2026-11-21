import { describe, expect, it } from "vitest";
import {
  SETTINGS_TABS, WORKSPACE_NAV, jobName, jobStatus, jobsForView, moneyTotals, parseRoute, problemLabel, roleLabel, routeHash, scheduleBars, stageLabel, subsFromJobs,
} from "../src/dashboard/views.js";
import { WORKSPACE_STAGES, projectJob } from "../src/workspace/projection.js";

const job = (over: Record<string, unknown> = {}) => ({ ...projectJob("r1", []), ...over });

describe("WORKSPACE_NAV and SETTINGS_TABS", () => {
  it("follow the Blueprint workspace's sidebar, with the owner's tools under Settings", () => {
    expect(WORKSPACE_NAV.map((n) => n.label)).toEqual(["Overview", "Find work", "Bids", "Projects", "Subs & vendors", "Schedule", "Money", "Closeout"]);
    expect(SETTINGS_TABS.map((t) => t.label)).toEqual(["Approvals", "Live log", "Past runs", "Start a run"]);
  });
});

describe("parseRoute and routeHash", () => {
  it("reads screens, Settings tabs and jobs", () => {
    expect(parseRoute("#bids")).toEqual({ view: "bids" });
    expect(parseRoute("#/money")).toEqual({ view: "money" });
    expect(parseRoute("#settings/live")).toEqual({ view: "settings", tab: "live" });
    expect(parseRoute("#settings")).toEqual({ view: "settings", tab: "approvals" });
    expect(parseRoute("#settings/nope")).toEqual({ view: "settings", tab: "approvals" });
    expect(parseRoute("#job/closeout-cloud-1%2F2")).toEqual({ view: "job", runId: "closeout-cloud-1/2" });
    expect(parseRoute("#job/%E0%A4%A")).toEqual({ view: "job", runId: "%E0%A4%A" });
  });
  it("falls back to the overview", () => {
    for (const h of ["", "#", "#nope", "#job", "#job/", "#__proto__", undefined, 7]) expect(parseRoute(h)).toEqual({ view: "overview" });
  });
  it("round-trips", () => {
    for (const r of [{ view: "bids" }, { view: "settings", tab: "start" }, { view: "job", runId: "a/b c" }]) expect(parseRoute(routeHash(r))).toEqual(r);
    expect(routeHash({ view: "settings" })).toBe("#settings/approvals");
  });
});

describe("stageLabel, roleLabel, problemLabel", () => {
  it("has a word for every stage", () => {
    for (const s of WORKSPACE_STAGES) expect(stageLabel(s)).toMatch(/^[A-Z]/);
    expect(stageLabel("pay")).toBe("Get paid");
    expect(stageLabel("toString")).toBe("ToString");
    expect(stageLabel(undefined)).toBe("");
  });
  it("words roles and problems", () => {
    expect(roleLabel("project_manager")).toBe("Project manager");
    expect(roleLabel("")).toBe("Agent");
    expect(roleLabel("hr")).toBe("HR");
    expect(problemLabel("failed-inspection")).toBe("Failed inspection");
    expect(problemLabel(null)).toBe("Problem");
  });
});

describe("jobStatus and jobName", () => {
  it("words and colours each status", () => {
    expect(jobStatus({ status: "closed" })).toEqual({ text: "Closed", tone: "success" });
    expect(jobStatus({ status: "lost" })).toEqual({ text: "Lost", tone: "danger" });
    expect(jobStatus({ status: "passed" })).toEqual({ text: "Passed", tone: "neutral" });
    expect(jobStatus({ status: "active", finished: true })).toEqual({ text: "Stopped", tone: "warning" });
    expect(jobStatus({ status: "active", finished: false })).toEqual({ text: "In progress", tone: "info" });
  });
  it("names a job by title, then notice, then run", () => {
    expect(jobName({ title: " Paint ", noticeId: "N", runId: "r" })).toBe("Paint");
    expect(jobName({ title: "", noticeId: "N", runId: "r" })).toBe("N");
    expect(jobName({ runId: "r" })).toBe("r");
    expect(jobName({})).toBe("Untitled job");
  });
});

describe("jobsForView", () => {
  const found = job({ runId: "a", noticeId: "N1" });
  const bid = job({ runId: "b", noticeId: "N2", estimateUsd: 10, bidStatus: "submitted", stage: "award" });
  const built = job({ runId: "c", noticeId: "N3", contractUsd: 100, schedule: [{ trade: "paint", startDay: 0, days: 3 }], stage: "schedule" });
  const closed = job({ runId: "d", noticeId: "N4", contractUsd: 50, status: "closed", stage: "closeout", invoicedUsd: 50 });
  const all = [found, bid, built, closed, null];
  const ids = (v: string) => jobsForView(v, all).map((j) => j.runId);
  it("lists the jobs that reached each screen's part of the work", () => {
    expect(ids("overview")).toEqual(["a", "b", "c", "d"]);
    expect(ids("find_work")).toEqual(["a", "b", "c", "d"]);
    expect(ids("bids")).toEqual(["b"]);
    expect(ids("projects")).toEqual(["c", "d"]);
    expect(ids("schedule")).toEqual(["c"]);
    expect(ids("money")).toEqual(["c", "d"]);
    expect(ids("closeout")).toEqual(["d"]);
  });
  it("tolerates no jobs", () => {
    expect(jobsForView("bids", undefined as unknown as [])).toEqual([]);
  });
});

describe("moneyTotals", () => {
  it("adds up live jobs, with change orders in the contract", () => {
    const t = moneyTotals([
      job({ contractUsd: 100, changeOrdersUsd: 20, costUsd: 80, invoicedUsd: 120, receivedUsd: 100, paidOutUsd: 80, profitUsd: 20 }),
      job({ contractUsd: 50, costUsd: 30, profitUsd: null }),
      job({ status: "lost", contractUsd: 999, costUsd: 999 }),
      null,
    ]);
    expect(t).toEqual({ contractUsd: 170, costUsd: 110, invoicedUsd: 120, receivedUsd: 100, owedToUsUsd: 20, paidOutUsd: 80, profitUsd: 20 });
  });
  it("is all zeros for nothing", () => {
    expect(moneyTotals([])).toEqual({ contractUsd: 0, costUsd: 0, invoicedUsd: 0, receivedUsd: 0, owedToUsUsd: 0, paidOutUsd: 0, profitUsd: 0 });
  });
});

describe("subsFromJobs", () => {
  it("groups quotes by subcontractor across jobs, biggest picked value first", () => {
    const q = (subcontractor: string, trade: string, priceUsd: number, selected: boolean) => ({ quoteId: subcontractor + trade, subcontractor, trade, priceUsd, selected });
    const subs = subsFromJobs([
      job({ runId: "a", quotes: [q("Apex", "paint", 10, true), q("Keystone", "paint", 9, false)] }),
      job({ runId: "b", quotes: [q("Apex", "floor", 5, false), q("Keystone", "paint", 30, true), q("", "x", 1, false)] }),
    ]);
    expect(subs).toEqual([
      { name: "Keystone", trades: ["paint"], quotes: 2, selected: 1, selectedUsd: 30, jobs: 2 },
      { name: "Apex", trades: ["paint", "floor"], quotes: 2, selected: 1, selectedUsd: 10, jobs: 2 },
      { name: "Unnamed", trades: ["x"], quotes: 1, selected: 0, selectedUsd: 0, jobs: 1 },
    ]);
    expect(subsFromJobs([])).toEqual([]);
  });
});

describe("scheduleBars", () => {
  it("places lines on the longer of the contract and the plan", () => {
    expect(scheduleBars({ schedule: [{ trade: "paint", startDay: 0, days: 6 }, { trade: "floor", startDay: 6, days: 7 }], contractDays: 20 })).toEqual({
      totalDays: 20, bars: [{ trade: "paint", startDay: 0, days: 6, left: 0, width: 30 }, { trade: "floor", startDay: 6, days: 7, left: 30, width: 35 }],
    });
    expect(scheduleBars({ schedule: [{ trade: "x", startDay: 2, days: 8 }], contractDays: 5 }).totalDays).toBe(10);
  });
  it("copes with nothing scheduled and bad values", () => {
    expect(scheduleBars({})).toEqual({ totalDays: 1, bars: [] });
    expect(scheduleBars({ schedule: [null, { trade: "y", startDay: -3, days: "4" }] }).bars).toEqual([{ trade: "y", startDay: 0, days: 0, left: 0, width: 0 }]);
  });
});
