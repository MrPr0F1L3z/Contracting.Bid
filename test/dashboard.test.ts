import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardServer, parseDecision, summarize } from "../src/dashboard/server.js";
import { DASHBOARD_HTML } from "../src/dashboard/page.js";
import { MAX_FAILURES, MemoryUserStore, newUser, totpCode, type DashboardUser } from "../src/dashboard/auth.js";
import { InMemoryEventLog } from "../src/events/eventLog.js";
import type { ApprovalRequest } from "../src/approvals/approvals.js";

const plain = { id: 1, gate: "submit_bid", requestedBy: "pm#3", summary: "Bid $100" } as ApprovalRequest;
const batch = {
  id: 2, gate: "release_payment", requestedBy: "bk#6", summary: "Pay 2 bills",
  items: [{ id: "B-1", label: "Sub A" }, { id: "B-2", label: "Sub B" }],
} as ApprovalRequest;
const PASSWORD = "a long enough phrase";

let owner: DashboardUser;
beforeAll(async () => {
  owner = await newUser("owner", PASSWORD);
});
const usersWithOwner = async () => {
  const users = new MemoryUserStore();
  await users.put(owner);
  return users;
};

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
    expect(parseDecision([true], plain)).toBe("Body must be a JSON object");
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
  it("holds an approval until a user decides, then resolves it with their name", async () => {
    const d = new DashboardServer({ runsDir: "nowhere", users: new MemoryUserStore() });
    const answer = d.approver()({ ...batch });
    expect(d.pendingRequests()).toEqual([batch]);
    expect(d.decide(9, { approve: true }, "owner")).toBe("No pending approval 9");
    expect(d.decide(2, { approve: true, items: ["B-9"] }, "owner")).toBe("Unknown item B-9");
    expect(d.pendingRequests()).toHaveLength(1);
    expect(d.decide(2, { approve: true, items: ["B-1"], reason: "hold B-2" }, "owner")).toBeNull();
    expect(await answer).toEqual({ approve: true, items: ["B-1"], reason: "hold B-2", by: "owner" });
    expect(d.pendingRequests()).toEqual([]);
  });

  it("tees events into the wrapped log and keeps the last 500", () => {
    const d = new DashboardServer({ runsDir: "nowhere", users: new MemoryUserStore() });
    const inner = new InMemoryEventLog();
    const log = d.tee(inner);
    for (let i = 0; i < 502; i++) log.append({ runId: "r", simTime: 0, type: "e", actor: "a", payload: { i } });
    expect(inner.list()).toHaveLength(502);
    expect(log.list()).toEqual(inner.list());
    const recent = (d as unknown as { recent: Array<{ payload: { i: number } }> }).recent;
    expect(recent).toHaveLength(500);
    expect(recent[0]!.payload.i).toBe(2);
  });

  it("refuses plain HTTP beyond this machine, and starting with no logins", async () => {
    await expect(new DashboardServer({ runsDir: "x", users: await usersWithOwner(), host: "0.0.0.0", port: 0 }).start())
      .rejects.toThrow("will not serve plain HTTP on 0.0.0.0");
    await expect(new DashboardServer({ runsDir: "x", users: new MemoryUserStore(), port: 0 }).start())
      .rejects.toThrow("No dashboard logins exist yet");
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

  it("lists only run reports, newest file first, skipping broken and other files", async () => {
    await writeFile(join(dir, "a.json"), JSON.stringify({ runId: "a", outcome: "won" }));
    await writeFile(join(dir, "c.json"), JSON.stringify({ runId: "c" }));
    await writeFile(join(dir, "b.json"), "{not json");
    await writeFile(join(dir, "users.json"), JSON.stringify({ users: [{ username: "owner", passwordHash: "secret" }] }));
    await writeFile(join(dir, "list.json"), "[]");
    await writeFile(join(dir, "notes.txt"), "x");
    const d = new DashboardServer({ runsDir: dir, users: new MemoryUserStore() });
    expect((await d.listRuns()).map((r) => [r.file, r.runId, r.outcome])).toEqual([["c.json", "c", null], ["a.json", "a", "won"]]);
    expect(await d.readRun("users.json")).toBeNull();
    expect(await new DashboardServer({ runsDir: join(dir, "missing"), users: new MemoryUserStore() }).listRuns()).toEqual([]);
  });

  it("reads only plain report file names", async () => {
    await writeFile(join(dir, "a.json"), JSON.stringify({ runId: "a" }));
    const d = new DashboardServer({ runsDir: dir, users: new MemoryUserStore() });
    expect(await d.readRun("a.json")).toEqual({ runId: "a" });
    expect(await d.readRun("../a.json")).toBeNull();
    expect(await d.readRun("sub/a.json")).toBeNull();
    expect(await d.readRun("a.txt")).toBeNull();
    expect(await d.readRun("missing.json")).toBeNull();
  });
});

/** A small HTTP client that keeps the session cookie, like a browser on the dashboard page. */
function client(base: string) {
  let cookie = "";
  let csrf = "";
  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) => {
    const res = await fetch(base + path, {
      method: init.method ?? "GET",
      headers: { "x-requested-with": "dashboard", "x-csrf-token": csrf, ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
      ...(init.raw !== undefined ? { body: init.raw } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
    const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
    return { status: res.status, headers: res.headers, setCookie: set, body };
  };
  return {
    call,
    get cookie() { return cookie; },
    set cookie(v: string) { cookie = v; },
    get csrf() { return csrf; },
    async login(username: string, password: string, code: string) {
      const r = await call("/api/login", { method: "POST", body: { username, password, code } });
      if (r.status === 200) csrf = (r.body as { csrf: string }).csrf;
      return r;
    },
  };
}

describe("DashboardServer over HTTP (functional)", () => {
  let dir: string;
  let d: DashboardServer;
  let base: string;
  let t: number;
  let users: MemoryUserStore;
  const code = () => totpCode(owner.totpSecret, Math.floor(t / 30_000));
  const signedIn = async () => {
    const c = client(base);
    t += 30_000;
    expect((await c.login("owner", PASSWORD, code())).status).toBe(200);
    return c;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dash-"));
    await writeFile(join(dir, "run-1.json"), JSON.stringify({ runId: "run-1", seed: 1, outcome: "closed" }));
    t = 1_800_000_000_000;
    users = await usersWithOwner();
    d = new DashboardServer({ runsDir: dir, port: 0, users, now: () => t });
    base = (await d.start()).replace(/\/$/, "");
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
  afterEach(async () => {
    await d.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves the page to anyone, with strict security headers", async () => {
    const r = await client(base).call("/");
    expect(r.status).toBe(200);
    expect(r.body).toBe(DASHBOARD_HTML);
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("strict-transport-security")).toBeNull();
  });

  it("refuses every API call before sign-in", async () => {
    const c = client(base);
    for (const path of ["/api/me", "/api/state", "/api/runs", "/api/runs/run-1.json", "/api/stream"]) {
      expect(await c.call(path)).toMatchObject({ status: 401, body: { error: "Sign in first" } });
    }
    expect((await c.call("/api/approvals/1", { method: "POST", body: { approve: true } })).status).toBe(401);
    expect((await c.call("/nothing")).status).toBe(404);
  });

  it("signs in with name, password and code, and sets a strict session cookie", async () => {
    const c = client(base);
    t += 30_000;
    const r = await c.login("Owner ", PASSWORD, code().replace(/(\d{3})/, "$1 "));
    expect(r).toMatchObject({ status: 200, body: { username: "owner" } });
    expect(r.setCookie).toMatch(/^cb_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
    expect(await c.call("/api/me")).toMatchObject({ status: 200, body: { username: "owner", csrf: c.csrf } });
    expect((await users.get("owner"))!.lastTotpStep).toBe(Math.floor(t / 30_000));
  });

  it("refuses a wrong password, a wrong code or a reused code with one message", async () => {
    t += 30_000;
    const good = code();
    for (const [name, pass, c] of [["owner", "wrong password!!", good], ["owner", PASSWORD, "000000"], ["nobody", PASSWORD, good]]) {
      expect(await client(base).login(name!, pass!, c!)).toMatchObject({ status: 401, body: { error: "Wrong name, password or authenticator code" } });
    }
    expect((await client(base).login("owner", PASSWORD, good)).status).toBe(200);
    expect((await client(base).login("owner", PASSWORD, good)).status).toBe(401);
  });

  it("locks a name out after repeated failures, even with the right details", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await client(base).login("owner", "wrong password!!", "000000");
    t += 30_000;
    const r = await client(base).login("owner", PASSWORD, code());
    expect(r).toMatchObject({ status: 429, body: { error: "Too many failed logins. Try again in 15 minutes." } });
    expect(r.headers.get("retry-after")).toBe("870");
    t += 15 * 60_000;
    expect((await client(base).login("owner", PASSWORD, code())).status).toBe(200);
  });

  it("needs the page's header, a same-origin Origin and the CSRF token on every POST", async () => {
    const c = await signedIn();
    void d.approver()({ ...plain });
    const post = (headers: Record<string, string>) => c.call("/api/approvals/1", { method: "POST", body: { approve: true }, headers });
    expect(await post({ "x-requested-with": "" })).toMatchObject({ status: 403, body: { error: "Requests must come from the dashboard page" } });
    expect(await post({ origin: "https://evil.example" })).toMatchObject({ status: 403 });
    expect(await post({ "x-csrf-token": "wrong" })).toMatchObject({ status: 403, body: { error: "Missing or wrong CSRF token" } });
    expect(d.pendingRequests()).toHaveLength(1);
    expect(await post({ origin: base })).toMatchObject({ status: 200 });
  });

  it("lists and reads saved runs once signed in", async () => {
    const c = await signedIn();
    expect((await c.call("/api/runs")).body).toEqual([expect.objectContaining({ file: "run-1.json", runId: "run-1", outcome: "closed" })]);
    expect((await c.call("/api/runs/run-1.json")).body).toEqual({ runId: "run-1", seed: 1, outcome: "closed" });
    expect((await c.call("/api/runs/..%2Frun-1.json")).status).toBe(404);
    expect((await c.call("/api/runs/%E0%A4%A.json")).status).toBe(404);
    expect((await c.call("/api/runs/missing.json")).body).toEqual({ error: "No such report" });
  });

  it("resolves a pending approval from a POST, recording who decided", async () => {
    const c = await signedIn();
    const answer = d.approver()({ ...batch });
    expect((await c.call("/api/state")).body).toMatchObject({ pending: [batch], decided: [] });
    const post = (id: number, raw: string) => c.call(`/api/approvals/${id}`, { method: "POST", raw });
    expect(await post(2, "nope")).toMatchObject({ status: 400, body: { error: "Body must be JSON" } });
    expect(await post(2, JSON.stringify({ approve: true, items: ["X"] }))).toMatchObject({ status: 400, body: { error: "Unknown item X" } });
    expect(await post(5, JSON.stringify({ approve: true }))).toMatchObject({ status: 404, body: { error: "No pending approval 5" } });
    expect(await post(2, JSON.stringify({ approve: true, items: ["B-2"] }))).toMatchObject({ status: 200, body: { ok: true } });
    expect(await answer).toEqual({ approve: true, items: ["B-2"], by: "owner" });
    expect((await c.call("/api/state")).body).toMatchObject({ pending: [], decided: [{ request: batch, decision: { approve: true, items: ["B-2"], by: "owner" } }] });
  });

  it("refuses a body over 64 KB", async () => {
    const c = await signedIn();
    void d.approver()({ ...plain });
    const r = await c.call("/api/approvals/1", { method: "POST", body: { approve: true, reason: "x".repeat(70_000) } });
    expect(r).toMatchObject({ status: 400, body: { error: "Body too large" } });
    expect(d.pendingRequests()).toHaveLength(1);
  });

  it("signs out, and ends sessions after an hour idle", async () => {
    const c = await signedIn();
    const saved = c.cookie;
    expect((await c.call("/api/logout", { method: "POST", body: {} })).setCookie).toMatch(/^cb_session=; .*Max-Age=0/);
    c.cookie = saved;
    expect((await c.call("/api/me")).status).toBe(401);
    const c2 = await signedIn();
    t += 60 * 60_000 + 1;
    expect((await c2.call("/api/me")).status).toBe(401);
  });

  it("streams approvals, decisions and events to a signed-in page only", async () => {
    const c = await signedIn();
    const port = new URL(base).port;
    const frames: string[] = [];
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/stream", headers: { cookie: c.cookie } });
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
    d.tee().append({ runId: "r", simTime: 0, type: "bid_submitted", actor: "pm#3", payload: {} });
    void d.approver()({ ...plain });
    d.decide(1, { approve: false, reason: "no" }, "owner");
    await waitFor(() => frames.join("").includes("event: decided"));
    const text = frames.join("");
    expect(text).toContain(": connected");
    expect(text).toMatch(/event: event\ndata: \{[^\n]*"type":"bid_submitted"/);
    expect(text).toContain(`event: approval\ndata: ${JSON.stringify(plain)}`);
    expect(text).toContain(`event: decided\ndata: ${JSON.stringify({ id: 1, approve: false, reason: "no", by: "owner" })}`);
    // Once the session ends, the stream closes on the next broadcast.
    const ended = new Promise<void>((resolve) => req.on("close", () => resolve()));
    t += 60 * 60_000 + 1;
    d.tee().append({ runId: "r", simTime: 0, type: "later", actor: "pm#3", payload: {} });
    await ended;
    expect(frames.join("")).not.toContain('"type":"later"');
  });

  it("stops cleanly with a stream still open", async () => {
    const c = await signedIn();
    const port = new URL(base).port;
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/stream", headers: { cookie: c.cookie } });
    req.on("error", () => undefined);
    await new Promise<void>((resolve) => req.on("response", () => resolve()).end());
    await d.stop();
    await expect(fetch(base + "/")).rejects.toThrow();
  });
});

describe("DashboardServer secure modes (functional)", () => {
  const fixtures = join(import.meta.dirname, "fixtures");
  let d: DashboardServer | null = null;
  afterEach(async () => {
    await d?.stop();
    d = null;
  });

  it("serves HTTPS with HSTS and a __Host- Secure cookie", async () => {
    const cert = await readFile(join(fixtures, "tls-test-cert.pem"));
    const key = await readFile(join(fixtures, "tls-test-key.pem"));
    const t = 1_800_000_000_000;
    d = new DashboardServer({ runsDir: "nowhere", port: 0, users: await usersWithOwner(), tls: { cert, key }, now: () => t });
    const url = await d.start();
    expect(url).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/$/);
    const body = JSON.stringify({ username: "owner", password: PASSWORD, code: totpCode(owner.totpSecret, Math.floor(t / 30_000)) });
    const res = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const req = httpsRequest(new URL("/api/login", url), {
        method: "POST", ca: cert, headers: { "x-requested-with": "dashboard", "content-type": "application/json" },
      }, (r) => {
        r.resume();
        resolve({ status: r.statusCode ?? 0, headers: r.headers });
      });
      req.on("error", reject);
      req.end(body);
    });
    expect(res.status).toBe(200);
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000");
    expect(String(res.headers["set-cookie"])).toMatch(/^__Host-cb_session=[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  });

  it("behind a proxy, marks cookies Secure and limits by the forwarded address", async () => {
    let t = 1_800_000_000_000;
    d = new DashboardServer({ runsDir: "nowhere", port: 0, users: await usersWithOwner(), behindProxy: true, now: () => t });
    const base = (await d.start()).replace(/\/$/, "");
    const login = (ip: string, password: string) =>
      fetch(base + "/api/login", {
        method: "POST",
        headers: { "x-requested-with": "dashboard", "x-forwarded-for": `1.1.1.1, ${ip}` },
        body: JSON.stringify({ username: "someone", password, code: "000000" }),
      });
    for (let i = 0; i < MAX_FAILURES; i++) await login("9.9.9.9", "nope");
    expect((await login("9.9.9.9", "nope")).status).toBe(429);
    const other = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "x-requested-with": "dashboard", "x-forwarded-for": "8.8.8.8" },
      body: JSON.stringify({ username: "owner", password: PASSWORD, code: totpCode(owner.totpSecret, Math.floor((t += 30_000) / 30_000)) }),
    });
    expect(other.status).toBe(200);
    expect(other.headers.get("set-cookie")).toMatch(/^__Host-cb_session=.*; Secure$/);
    expect(other.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });
});

async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
