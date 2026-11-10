import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardServer, parseDecision, summarize } from "../src/dashboard/server.js";
import { DASHBOARD_HTML } from "../src/dashboard/page.js";
import { InMemoryEventLog } from "../src/events/eventLog.js";
import type { ApprovalRequest } from "../src/approvals/approvals.js";

const plain = { id: 1, gate: "submit_bid", requestedBy: "pm#3", summary: "Bid $100" } as ApprovalRequest;
const batch = {
  id: 2, gate: "release_payment", requestedBy: "bk#6", summary: "Pay 2 bills",
  items: [{ id: "B-1", label: "Sub A" }, { id: "B-2", label: "Sub B" }],
} as ApprovalRequest;

describe("parseDecision", () => {
  it("accepts approve, a trimmed reason, and known items", () => {
    expect(parseDecision({ approve: true }, plain)).toEqual({ approve: true });
    expect(parseDecision({ approve: false, reason: "  too high " }, plain)).toEqual({ approve: false, reason: "too high" });
    expect(parseDecision({ approve: false, reason: "   " }, plain)).toEqual({ approve: false });
    expect(parseDecision({ approve: true, items: ["B-2"] }, batch)).toEqual({ approve: true, items: ["B-2"] });
    expect(parseDecision({ approve: true, items: [] }, batch)).toEqual({ approve: true, items: [] });
  });
  it("names what is wrong with a bad body", () => {
    expect(parseDecision(null, plain)).toBe("Body must be a JSON object");
    expect(parseDecision("yes", plain)).toBe("Body must be a JSON object");
    expect(parseDecision({ approve: "yes" }, plain)).toBe("approve must be true or false");
    expect(parseDecision({ approve: true, reason: 3 }, plain)).toBe("reason must be text");
    expect(parseDecision({ approve: true, items: ["B-1"] }, plain)).toBe("This approval has no items");
    expect(parseDecision({ approve: true, items: "B-1" }, batch)).toBe("items must be a list of item ids");
    expect(parseDecision({ approve: true, items: [1] }, batch)).toBe("items must be a list of item ids");
    expect(parseDecision({ approve: true, items: ["B-9"] }, batch)).toBe("Unknown item B-9");
  });
});

describe("summarize", () => {
  it("reads the summary fields of a report", () => {
    expect(summarize("a.json", { runId: "r1", seed: 4, outcome: "closed", reason: "ok", opportunity: { noticeId: "STUB-E02" }, spentUsd: 0.2 }))
      .toEqual({ file: "a.json", runId: "r1", seed: 4, outcome: "closed", reason: "ok", job: "STUB-E02", spentUsd: 0.2 });
  });
  it("tolerates any report shape", () => {
    expect(summarize("run-7.json", { seed: "x", opportunity: null })).toEqual({
      file: "run-7.json", runId: "run-7", seed: null, outcome: null, reason: null, job: null, spentUsd: null,
    });
  });
});

describe("DashboardServer without HTTP", () => {
  it("holds an approval until the owner decides, then resolves it", async () => {
    const d = new DashboardServer({ runsDir: "nowhere", token: "t" });
    const answer = d.approver()({ ...batch });
    expect(d.pendingRequests()).toEqual([batch]);
    expect(d.decide(9, { approve: true })).toBe("No pending approval 9");
    expect(d.decide(2, { approve: true, items: ["B-9"] })).toBe("Unknown item B-9");
    expect(d.pendingRequests()).toHaveLength(1);
    expect(d.decide(2, { approve: true, items: ["B-1"], reason: "hold B-2" })).toBeNull();
    expect(await answer).toEqual({ approve: true, items: ["B-1"], reason: "hold B-2" });
    expect(d.pendingRequests()).toEqual([]);
    expect(d.decide(2, { approve: true })).toBe("No pending approval 2");
  });

  it("tees events into the wrapped log and keeps the last 500", () => {
    const d = new DashboardServer({ runsDir: "nowhere", token: "t" });
    const inner = new InMemoryEventLog();
    const log = d.tee(inner);
    for (let i = 0; i < 502; i++) log.append({ runId: "r", simTime: 0, type: "e", actor: "a", payload: { i } });
    expect(inner.list()).toHaveLength(502);
    expect(log.list()).toEqual(inner.list());
    const state = (d as unknown as { recent: Array<{ payload: { i: number } }> }).recent;
    expect(state).toHaveLength(500);
    expect(state[0]!.payload.i).toBe(2);
  });
});

describe("DashboardServer reports", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dash-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists reports newest file first, skipping other files, and survives a broken one", async () => {
    await writeFile(join(dir, "a.json"), JSON.stringify({ runId: "a", outcome: "won" }));
    await writeFile(join(dir, "b.json"), "{not json");
    await writeFile(join(dir, "notes.txt"), "x");
    const d = new DashboardServer({ runsDir: dir, token: "t" });
    expect((await d.listRuns()).map((r) => [r.file, r.runId, r.outcome])).toEqual([["b.json", "b", null], ["a.json", "a", "won"]]);
  });

  it("returns no runs when the folder is missing", async () => {
    expect(await new DashboardServer({ runsDir: join(dir, "missing"), token: "t" }).listRuns()).toEqual([]);
  });

  it("reads only plain report file names", async () => {
    await writeFile(join(dir, "a.json"), JSON.stringify({ runId: "a" }));
    const d = new DashboardServer({ runsDir: dir, token: "t" });
    expect(await d.readRun("a.json")).toEqual({ runId: "a" });
    expect(await d.readRun("../a.json")).toBeNull();
    expect(await d.readRun("sub/a.json")).toBeNull();
    expect(await d.readRun("a.txt")).toBeNull();
    expect(await d.readRun("missing.json")).toBeNull();
  });
});

describe("DashboardServer over HTTP (functional)", () => {
  let dir: string;
  let d: DashboardServer;
  let base: string;
  const call = async (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const { token = "secret", ...rest } = init;
    const res = await fetch(base + path, { ...rest, headers: { ...(token ? { "x-dashboard-token": token } : {}), ...(rest.headers ?? {}) } });
    return { status: res.status, headers: res.headers, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dash-"));
    await writeFile(join(dir, "run-1.json"), JSON.stringify({ runId: "run-1", seed: 1, outcome: "closed" }));
    d = new DashboardServer({ runsDir: dir, port: 0, token: "secret" });
    const url = await d.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=secret$/);
    base = url.replace(/\/#token=.*$/, "");
  });
  afterEach(async () => {
    await d.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves the page without a token, with a content security policy", async () => {
    const r = await call("/", { token: null });
    expect(r.status).toBe(200);
    expect(r.body).toBe(DASHBOARD_HTML);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses every API call without the right token", async () => {
    for (const token of [null, "wrong", "secre"]) {
      expect(await call("/api/state", { token })).toEqual(expect.objectContaining({ status: 401, body: { error: "Missing or wrong dashboard token" } }));
    }
    expect((await call("/api/approvals/1", { token: null, method: "POST", body: "{}" })).status).toBe(401);
    expect((await call("/api/state?token=secret", { token: null })).status).toBe(401);
    expect((await call("/nothing")).status).toBe(404);
    expect((await call("/api/nothing")).status).toBe(404);
  });

  it("lists and reads saved runs", async () => {
    expect((await call("/api/runs")).body).toEqual([expect.objectContaining({ file: "run-1.json", runId: "run-1", outcome: "closed" })]);
    expect((await call("/api/runs/run-1.json")).body).toEqual({ runId: "run-1", seed: 1, outcome: "closed" });
    expect((await call("/api/runs/..%2Frun-1.json")).status).toBe(404);
    expect((await call("/api/runs/missing.json")).body).toEqual({ error: "No such report" });
  });

  it("shows a pending approval and resolves it from a POST", async () => {
    const answer = d.approver()({ ...batch });
    expect((await call("/api/state")).body).toMatchObject({ pending: [batch], decided: [] });
    const post = (id: number, body: string) => call(`/api/approvals/${id}`, { method: "POST", body, headers: { "content-type": "application/json" } });
    expect(await post(2, "nope")).toMatchObject({ status: 400, body: { error: "Body must be JSON" } });
    expect(await post(2, JSON.stringify({ approve: true, items: ["X"] }))).toMatchObject({ status: 400, body: { error: "Unknown item X" } });
    expect(await post(5, JSON.stringify({ approve: true }))).toMatchObject({ status: 404, body: { error: "No pending approval 5" } });
    expect(await post(2, JSON.stringify({ approve: true, items: ["B-2"] }))).toMatchObject({ status: 200, body: { ok: true } });
    expect(await answer).toEqual({ approve: true, items: ["B-2"] });
    expect((await call("/api/state")).body).toMatchObject({ pending: [], decided: [{ request: batch, decision: { approve: true, items: ["B-2"] } }] });
  });

  it("refuses a body over 64 KB", async () => {
    void d.approver()({ ...plain });
    const r = await call("/api/approvals/1", { method: "POST", body: JSON.stringify({ approve: true, reason: "x".repeat(70_000) }) });
    expect(r).toMatchObject({ status: 400, body: { error: "Body too large" } });
    expect(d.pendingRequests()).toHaveLength(1);
  });

  it("streams approvals, decisions and events to the page", async () => {
    const port = new URL(base).port;
    const frames: string[] = [];
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/stream?token=secret" });
    const opened = new Promise<number>((resolve) => {
      req.on("response", (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => frames.push(chunk));
        resolve(res.statusCode ?? 0);
      });
    });
    req.on("error", () => undefined);
    req.end();
    expect(await opened).toBe(200);
    const log = d.tee();
    log.append({ runId: "r", simTime: 0, type: "bid_submitted", actor: "pm#3", payload: {} });
    void d.approver()({ ...plain });
    d.decide(1, { approve: false, reason: "no" });
    await waitFor(() => frames.join("").includes("event: decided"));
    const text = frames.join("");
    expect(text).toContain(": connected");
    expect(text).toMatch(/event: event\ndata: \{[^\n]*"type":"bid_submitted"/);
    expect(text).toContain(`event: approval\ndata: ${JSON.stringify(plain)}`);
    expect(text).toContain(`event: decided\ndata: ${JSON.stringify({ id: 1, approve: false, reason: "no" })}`);
    expect((await call("/api/state")).body.events).toHaveLength(1);
    req.destroy();
  });

  it("stops cleanly with a stream still open", async () => {
    const port = new URL(base).port;
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/stream?token=secret" });
    await new Promise<void>((resolve) => req.on("response", () => resolve()).end());
    req.on("error", () => undefined);
    await d.stop();
    await expect(fetch(base + "/")).rejects.toThrow();
  });
});

async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
