/**
 * Functional test of the owner dashboard in a real browser: a scripted run
 * from hiring to closeout feeds the server, the owner signs in, every
 * workspace screen shows the run's data, and Settings holds the owner's tools.
 *
 * Needs Chromium. CI installs it; locally set PW_CHROMIUM_PATH to one you
 * have. Without a browser the test is skipped, except in CI where it fails.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { DashboardServer } from "../src/dashboard/server.js";
import { MemoryUserStore, newUser, totpCode } from "../src/dashboard/auth.js";
import { runCloseoutChain } from "../src/sim/closeoutChain.js";
import { stubJobProviders } from "../src/sim/stubJob.js";
import { STUB_BID_JOB } from "../src/sim/stubBid.js";
import { ModelRouter } from "../src/models/router.js";
import type { ApprovalRequest } from "../src/approvals/approvals.js";

const PASSWORD = "a long enough phrase";
const SLOW = { timeout: 20_000 };
let browser: Browser | null = null;
try {
  browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
} catch (e) {
  if (process.env.CI) throw e;
}

describe.skipIf(!browser)("owner dashboard in a browser", () => {
  let d: DashboardServer;
  let base: string;
  let page: Page;
  let secret: string;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    const users = new MemoryUserStore();
    const owner = await newUser("owner", PASSWORD);
    secret = owner.totpSecret;
    await users.put(owner);
    d = new DashboardServer({ runsDir: "nowhere", users });
    base = await d.start();
    // A whole scripted run, streamed through the dashboard as a live run would be.
    const run = await runCloseoutChain({
      runId: "browser-run-7", seed: 3, router: new ModelRouter(stubJobProviders()), approver: async () => ({ approve: true }),
      runBudgetUsd: 5, noticeId: STUB_BID_JOB, forceAward: true,
    });
    const log = d.tee();
    for (const { seq: _seq, ...e } of run.events) log.append(e);
    // And one decision still waiting on the owner.
    void d.approver("browser-run-8")({ id: 1, gate: "submit_bid", requestedBy: "president#1", summary: "Submit a $1,200 bid on STUB-E01. Low risk.", amountUsd: 1200 } as ApprovalRequest);
    page = await browser!.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
  });

  afterAll(async () => {
    await browser?.close();
    await d?.stop();
  });

  const main = () => page.locator("main > section:not([hidden])");

  it("signs in and opens on the workspace overview, filled from the run", async () => {
    await page.goto(base);
    await page.getByLabel("Login name").fill("owner");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByLabel("6-digit code from your authenticator app").fill(totpCode(secret, Math.floor(Date.now() / 30_000)));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect.poll(() => main().locator("h1").first().textContent()).toBe("Overview");
    await expect.poll(() => main().locator("table").first().textContent()).toContain("Closed");
    const kpis = await main().locator(".kpi").allTextContents();
    expect(kpis[0]).toContain("Needs you1");
    expect(await main().textContent()).toContain("Submit a bid");
  }, SLOW.timeout);

  it("has the Blueprint sidebar with Settings at its foot", async () => {
    expect(await page.locator("#nav a").allTextContents()).toEqual(["Overview", "Find work", "Bids", "Projects", "Subs & vendors", "Schedule", "Money", "Closeout"]);
    expect((await page.locator("#settingsLink").textContent())?.trim()).toBe("Settings1");
  }, SLOW.timeout);

  it("shows the run on every workspace screen", async () => {
    const expectations: Array<[string, string]> = [
      ["Find work", "Pursued"], ["Bids", "Won"], ["Projects", "solved"], ["Subs & vendors", "Picked value"],
      ["Schedule", "day 0"], ["Money", "Paid to subs"], ["Closeout", "Cash profit"],
    ];
    for (const [link, text] of expectations) {
      await page.locator("#nav a", { hasText: link }).click();
      await expect.poll(() => main().locator("h1").first().textContent(), { message: link }).toBe(link);
      await expect.poll(() => main().textContent(), { message: link }).toContain(text);
      expect(await page.locator(`#nav a[aria-current="page"]`).textContent()).toBe(link);
    }
  }, SLOW.timeout);

  it("opens one job with its stages, quotes, team and decisions", async () => {
    await page.locator("#nav a", { hasText: "Projects" }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#projects");
    await page.locator("#v-projects table a.link").first().click({ timeout: 5000 });
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#job/browser-run-7");
    await expect.poll(() => page.locator("#v-job").isVisible()).toBe(true);
    const text = (await main().textContent()) ?? "";
    for (const part of ["Quotes", "Schedule", "Problems on site", "Team", "Project manager", "Your decisions", "browser-run-7"]) expect(text).toContain(part);
    expect(await main().locator(".stepper span.now").textContent()).toBe("Closeout");
  }, SLOW.timeout);

  it("keeps approvals, the live log, past runs and starting a run on Settings", async () => {
    await page.locator("#settingsLink").click();
    await expect.poll(() => main().locator("h1").first().textContent()).toBe("Settings");
    expect(await page.locator(".tabs a:not([hidden])").allTextContents()).toEqual(["Approvals 1", "Live log", "Past runs"]);
    await expect.poll(() => page.locator("#approvals").isVisible()).toBe(true);
    expect(await page.locator("#approvalsBody").textContent()).toContain("STUB-E01");

    await page.locator(".tabs a", { hasText: "Live log" }).click();
    await expect.poll(() => page.locator("#live").isVisible()).toBe(true);
    expect(await page.locator("#log .ev").count()).toBeGreaterThan(10);

    await page.locator(".tabs a", { hasText: "Past runs" }).click();
    await expect.poll(() => page.locator("#runs").isVisible()).toBe(true);

    await page.locator(".tabs a", { hasText: "Approvals" }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => page.locator("#approvalsBody").textContent()).toContain("Nothing is waiting for you");
    expect(await page.locator("#settingsLink .badge").isHidden()).toBe(true);
    expect(d.pendingRequests()).toEqual([]);
  }, SLOW.timeout);

  it("follows the back button between screens", async () => {
    await page.goBack();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#settings/runs");
    await expect.poll(() => page.locator("#runs").isVisible()).toBe(true);
  }, SLOW.timeout);

  it("raised no script errors on the page", () => {
    expect(pageErrors).toEqual([]);
  });
});
