import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseSimArgs } from "../src/cli/sim.js";
import { dashboardOptions, runUserCommand, usersFile, DEFAULT_USERS_FILE } from "../src/cli/dashboardCli.js";
import { FileUserStore, MemoryUserStore, newUser, totpCode, verifyPassword } from "../src/dashboard/auth.js";
import { stubBidProviders } from "../src/sim/stubBid.js";
import type { ApprovalRequest } from "../src/approvals/approvals.js";

const PASSWORD = "a long enough phrase";

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

describe("dashboardOptions", () => {
  const read = async (p: string) => Buffer.from(`pem:${p}`);
  it("defaults to loopback HTTP with the default users file", async () => {
    const o = await dashboardOptions({}, "runs", 4100, read);
    expect(o).toMatchObject({ runsDir: "runs", port: 4100 });
    expect(o.host).toBeUndefined();
    expect(o.tls).toBeUndefined();
    expect(o.behindProxy).toBeUndefined();
    expect(o.users).toBeInstanceOf(FileUserStore);
    expect(usersFile({})).toBe(DEFAULT_USERS_FILE);
    expect(usersFile({ DASHBOARD_USERS_FILE: "x.json" })).toBe("x.json");
  });
  it("reads the host, certificate files and proxy setting", async () => {
    expect(await dashboardOptions({ DASHBOARD_HOST: "0.0.0.0", DASHBOARD_TLS_CERT: "c.pem", DASHBOARD_TLS_KEY: "k.pem" }, "runs", 0, read))
      .toMatchObject({ host: "0.0.0.0", tls: { cert: Buffer.from("pem:c.pem"), key: Buffer.from("pem:k.pem") } });
    for (const v of ["1", "true", "YES"]) expect((await dashboardOptions({ DASHBOARD_BEHIND_PROXY: v }, "runs", 0, read)).behindProxy).toBe(true);
    expect((await dashboardOptions({ DASHBOARD_BEHIND_PROXY: "0" }, "runs", 0, read)).behindProxy).toBeUndefined();
  });
  it("names a bad TLS setting", async () => {
    await expect(dashboardOptions({ DASHBOARD_TLS_CERT: "c.pem" }, "runs", 0, read)).rejects.toThrow("Set both DASHBOARD_TLS_CERT and DASHBOARD_TLS_KEY");
    await expect(dashboardOptions({ DASHBOARD_TLS_CERT: "c", DASHBOARD_TLS_KEY: "k" }, "runs", 0, async () => { throw new Error("ENOENT"); }))
      .rejects.toThrow("Cannot read the TLS certificate or key: ENOENT");
    await expect(dashboardOptions({ DASHBOARD_TLS_CERT: "c", DASHBOARD_TLS_KEY: "k", DASHBOARD_BEHIND_PROXY: "1" }, "runs", 0, read))
      .rejects.toThrow("not both");
  });
});

describe("pnpm sim user", () => {
  let t: number;
  let lines: string[];
  let store: MemoryUserStore;
  const out = (l: string) => void lines.push(l);
  const secretShown = () => lines.findLast((l) => l.startsWith("  Secret key: "))!.slice("  Secret key: ".length).replace(/ /g, "");
  /** Answers the code prompt with the right code for whatever secret was just shown. */
  const codes = (...wrong: string[]) => async () => wrong.shift() ?? totpCode(secretShown(), Math.floor(t / 30_000));
  const run = (argv: string[], secrets: string[], ask = codes()) =>
    runUserCommand(argv, { out, store, now: () => t, askSecret: async () => secrets.shift() ?? "", ask });

  beforeEach(() => {
    t = 1_800_000_000_000;
    lines = [];
    store = new MemoryUserStore();
  });

  it("adds a login after the authenticator code checks out", async () => {
    expect(await run(["add", "Owner"], [PASSWORD, PASSWORD], codes("123456"))).toBe(0);
    expect(lines).toContain("That code does not match. Check the secret and the device's clock.");
    expect(lines.find((l) => l.includes("otpauth://"))).toContain("otpauth://totp/Contracting.Bid%3Aowner?secret=");
    expect(lines.at(-1)).toBe("Created owner.");
    const u = (await store.get("owner"))!;
    expect(await verifyPassword(PASSWORD, u.passwordHash)).toBe(true);
    expect(u.totpSecret).toBe(secretShown());
    expect(u.lastTotpStep).toBe(Math.floor(t / 30_000));
  });

  it("saves nothing on a weak or mistyped password, or three wrong codes", async () => {
    expect(await run(["add", "owner"], ["short", "short"])).toBe(1);
    expect(lines).toEqual(["Use at least 12 characters"]);
    expect(await run(["add", "owner"], [PASSWORD, "something else entirely"])).toBe(1);
    expect(lines.at(-1)).toBe("The passwords did not match");
    expect(await run(["add", "owner"], [PASSWORD, PASSWORD], codes("1", "2", "3"))).toBe(1);
    expect(lines.at(-1)).toBe("Nothing was saved. Run the command again.");
    expect(await run(["add", "a"], [PASSWORD, PASSWORD])).toBe(1);
    expect(lines.at(-1)).toBe("A login name is 2-32 lowercase letters, digits, dots, dashes or underscores");
    expect(await store.list()).toEqual([]);
  });

  it("changes a password, resets the authenticator, lists and removes", async () => {
    await store.put(await newUser("owner", PASSWORD));
    const before = (await store.get("owner"))!;
    expect(await run(["add", "owner"], [])).toBe(1);
    expect(lines.at(-1)).toBe("owner already exists. Use passwd or reset-code to change it.");
    expect(await run(["passwd", "owner"], ["a different long phrase", "a different long phrase"])).toBe(0);
    expect(await verifyPassword("a different long phrase", (await store.get("owner"))!.passwordHash)).toBe(true);
    expect(await run(["reset-code", "owner"], [], codes("1", "2", "3"))).toBe(1);
    expect(lines.at(-1)).toBe("Nothing was changed. The old authenticator still works.");
    expect((await store.get("owner"))!.totpSecret).toBe(before.totpSecret);
    expect(await run(["reset-code", "owner"], [])).toBe(0);
    expect((await store.get("owner"))!.totpSecret).not.toBe(before.totpSecret);
    lines = [];
    expect(await run(["list"], [])).toBe(0);
    expect(lines).toEqual([`owner  (created ${before.createdAt.slice(0, 10)})`]);
    expect(await run(["remove", "owner"], [])).toBe(0);
    expect(await run(["remove", "owner"], [])).toBe(1);
    expect(lines.at(-1)).toBe("No login named owner");
    expect(await run(["passwd", "ghost"], [])).toBe(1);
    lines = [];
    expect(await run(["list"], [])).toBe(0);
    expect(lines).toEqual(["No dashboard logins yet. Create one with: pnpm sim user add NAME"]);
  });

  it("prints usage for a bad command line, through main too", async () => {
    for (const argv of [[], ["add"], ["list", "x"], ["nope", "x"], ["add", "a", "b"]]) {
      lines = [];
      expect(await run(argv, [])).toBe(2);
      expect(lines[0]).toMatch(/^Usage:/);
    }
    lines = [];
    expect(await main(["user", "help"], { out })).toBe(0);
    expect(lines[0]).toMatch(/^Usage:\n  pnpm sim user add NAME/);
    lines = [];
    expect(await main(["user", "list"], { out, user: { store } })).toBe(0);
    expect(lines).toEqual(["No dashboard logins yet. Create one with: pnpm sim user add NAME"]);
  });
});

describe("pnpm sim dashboard (functional)", () => {
  let dir: string;
  let lines: string[];
  let env: Record<string, string>;
  const out = (l: string) => void lines.push(l);
  const urlFrom = () => lines.find((l) => l.startsWith("Owner dashboard: "))!.slice("Owner dashboard: ".length).replace(/\/$/, "");
  let secret: string;

  /** Signs in like the page, and returns a fetch that carries the session. */
  async function signIn(base: string) {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "x-requested-with": "dashboard" },
      body: JSON.stringify({ username: "owner", password: PASSWORD, code: totpCode(secret, Math.floor(Date.now() / 30_000)) }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf } = (await res.json()) as { csrf: string };
    return async (path: string, init: RequestInit = {}) =>
      (await fetch(`${base}${path}`, { ...init, headers: { cookie, "x-csrf-token": csrf, "x-requested-with": "dashboard" } })).json();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dash-cli-"));
    lines = [];
    env = { DASHBOARD_PORT: "0", DASHBOARD_USERS_FILE: join(dir, "users.json") };
    const user = await newUser("owner", PASSWORD);
    secret = user.totpSecret;
    await new FileUserStore(env.DASHBOARD_USERS_FILE!).put(user);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serves saved reports to a signed-in user until stopped", async () => {
    await writeFile(join(dir, "bid-1.json"), JSON.stringify({ runId: "bid-1", outcome: "won" }));
    let seen: unknown;
    const code = await main(["dashboard", "--out", dir], {
      out, env,
      untilStopped: async () => {
        seen = await (await signIn(urlFrom()))("/api/runs");
      },
    });
    expect(code).toBe(0);
    expect(lines[1]).toBe("Press Ctrl+C to stop.");
    expect(seen).toEqual([expect.objectContaining({ file: "bid-1.json", outcome: "won" })]);
    await expect(fetch(urlFrom())).rejects.toThrow();
  });

  it("explains why it cannot start", async () => {
    expect(await main(["dashboard"], { out, env: { DASHBOARD_PORT: "web" } })).toBe(2);
    expect(lines).toEqual(['DASHBOARD_PORT must be a port number, not "web"']);
    lines = [];
    expect(await main(["dashboard"], { out, env: { ...env, DASHBOARD_USERS_FILE: join(dir, "none.json") } })).toBe(2);
    expect(lines).toEqual(["No dashboard logins exist yet. Create one with: pnpm sim user add <name>"]);
    lines = [];
    expect(await main(["dashboard"], { out, env: { ...env, DASHBOARD_HOST: "0.0.0.0" } })).toBe(2);
    expect(lines[0]).toMatch(/will not serve plain HTTP on 0\.0\.0\.0/);
    lines = [];
    const deps = { out, env: { ...env, DASHBOARD_TLS_CERT: "only-cert.pem" }, providers: stubBidProviders("cloud"), writeReport: async () => undefined };
    expect(await main(["bid", "--job", "STUB-E02", "--seed", "2", "--dashboard"], deps)).toBe(2);
    expect(lines).toEqual(["Set both DASHBOARD_TLS_CERT and DASHBOARD_TLS_KEY, or neither"]);
  });

  it("runs a bid whose approvals a signed-in user answers on the dashboard", async () => {
    const terminal: string[] = [];
    const written: string[] = [];
    const answered: string[] = [];
    let done = false;
    const run = main(["bid", "--job", "STUB-E02", "--seed", "2", "--dashboard", "--out", dir], {
      out, env,
      now: () => new Date("2026-11-10T00:00:00Z"),
      providers: stubBidProviders("cloud"),
      approver: async (r) => (terminal.push(r.gate), { approve: true }),
      writeReport: async (p, json) => void written.push(json),
    }).finally(() => (done = true));
    let api: Awaited<ReturnType<typeof signIn>> | null = null;
    while (!done) {
      try {
        if (!api && lines.some((l) => l.startsWith("Owner dashboard: "))) api = await signIn(urlFrom());
        if (api) {
          const state = (await api("/api/state")) as { pending: ApprovalRequest[] };
          for (const p of state.pending) {
            answered.push(p.gate);
            await api(`/api/approvals/${p.id}`, { method: "POST", body: JSON.stringify({ approve: true }) });
          }
        }
      } catch {
        // the run finished and the dashboard closed between checks
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await run).toBe(0);
    expect(terminal).toEqual([]);
    expect(answered).toEqual(["pursue_opportunity", "hire_agent", "hire_agent", "submit_bid"]);
    expect(lines[1]).toBe("Sign in there to answer approvals; the run waits for you.");
    const report = JSON.parse(written[0]!) as { approvals: Array<{ gate: string; decidedBy: string }> };
    expect(report.approvals.find((a) => a.gate === "submit_bid")!.decidedBy).toBe("owner:owner");
  });

  it("ignores --dashboard with --auto-approve", async () => {
    const code = await main(["bid", "--job", "STUB-E02", "--seed", "2", "--dashboard", "--auto-approve"], {
      out, env, providers: stubBidProviders("cloud"), writeReport: async () => undefined,
    });
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith("Owner dashboard"))).toBe(false);
  });
});
