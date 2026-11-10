import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseSimArgs } from "../src/cli/sim.js";
import { stubBidProviders } from "../src/sim/stubBid.js";
import type { ApprovalRequest } from "../src/approvals/approvals.js";

describe("parseSimArgs: dashboard", () => {
  it("reads the dashboard command and the --dashboard flag", () => {
    expect(parseSimArgs(["dashboard"])).toMatchObject({ command: "dashboard", out: "runs" });
    expect(parseSimArgs(["dashboard", "--out", "elsewhere"])).toMatchObject({ command: "dashboard", out: "elsewhere" });
    for (const c of ["bid", "job", "closeout"]) expect(parseSimArgs([c, "--dashboard"])).toMatchObject({ command: c, dashboard: true });
  });
  it("rejects the flag elsewhere and other options on the dashboard command", () => {
    expect(() => parseSimArgs(["hiring", "--dashboard"])).toThrow("--dashboard is only for bid, job and closeout");
    expect(() => parseSimArgs(["dashboard", "--dashboard"])).toThrow("--dashboard is only for bid, job and closeout");
    expect(() => parseSimArgs(["dashboard", "--seed", "3"])).toThrow("dashboard takes only --out");
    expect(() => parseSimArgs(["dashboard", "--stub"])).toThrow("dashboard takes only --out");
  });
});

describe("pnpm sim dashboard (functional)", () => {
  let dir: string;
  let lines: string[];
  const out = (l: string) => void lines.push(l);
  const urlFrom = () => lines.find((l) => l.startsWith("Owner dashboard: "))!.slice("Owner dashboard: ".length);
  const api = async (url: string, path: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const token = new URLSearchParams(u.hash.slice(1)).get("token")!;
    const res = await fetch(`${u.origin}${path}`, { ...init, headers: { "x-dashboard-token": token, "content-type": "application/json" } });
    return res.json();
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dash-cli-"));
    lines = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serves saved reports until stopped", async () => {
    await writeFile(join(dir, "bid-1.json"), JSON.stringify({ runId: "bid-1", outcome: "won" }));
    let seen: unknown;
    const code = await main(["dashboard", "--out", dir], {
      out,
      env: { DASHBOARD_PORT: "0" },
      untilStopped: async () => {
        seen = await api(urlFrom(), "/api/runs");
      },
    });
    expect(code).toBe(0);
    expect(lines[1]).toBe("Press Ctrl+C to stop.");
    expect(seen).toEqual([expect.objectContaining({ file: "bid-1.json", outcome: "won" })]);
    await expect(fetch(new URL(urlFrom()).origin)).rejects.toThrow();
  });

  it("refuses a bad DASHBOARD_PORT", async () => {
    expect(await main(["dashboard"], { out, env: { DASHBOARD_PORT: "web" } })).toBe(2);
    expect(lines).toEqual(['DASHBOARD_PORT must be a port number, not "web"']);
  });

  it("runs a bid whose approvals the owner answers on the dashboard", async () => {
    const terminal: string[] = [];
    const written: string[] = [];
    const answered: string[] = [];
    let done = false;
    const run = main(["bid", "--job", "STUB-E02", "--seed", "2", "--dashboard", "--out", dir], {
      out,
      env: { DASHBOARD_PORT: "0" },
      now: () => new Date("2026-11-10T00:00:00Z"),
      providers: stubBidProviders("cloud"),
      approver: async (r) => (terminal.push(r.gate), { approve: true }),
      writeReport: async (p) => void written.push(p),
    }).finally(() => (done = true));
    while (!done) {
      const url = lines.find((l) => l.startsWith("Owner dashboard: ")) ? urlFrom() : null;
      if (url) {
        try {
          const state = (await api(url, "/api/state")) as { pending: ApprovalRequest[] };
          for (const p of state.pending) {
            answered.push(p.gate);
            await api(url, `/api/approvals/${p.id}`, { method: "POST", body: JSON.stringify({ approve: true }) });
          }
        } catch {
          // the run finished and the dashboard closed between checks
        }
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await run).toBe(0);
    expect(terminal).toEqual([]);
    expect(answered).toEqual(["pursue_opportunity", "hire_agent", "hire_agent", "submit_bid"]);
    expect(lines[1]).toBe("Open it to answer approvals; the run waits for you there.");
    expect(written).toHaveLength(1);
  });

  it("ignores --dashboard with --auto-approve", async () => {
    const code = await main(["bid", "--job", "STUB-E02", "--seed", "2", "--dashboard", "--auto-approve"], {
      out, env: { DASHBOARD_PORT: "0" }, providers: stubBidProviders("cloud"), writeReport: async () => undefined,
    });
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith("Owner dashboard"))).toBe(false);
  });
});
