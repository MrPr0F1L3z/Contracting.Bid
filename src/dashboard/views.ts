/**
 * Helpers the dashboard page runs in the browser to turn workspace data
 * (src/workspace/projection.ts, served at /api/workspace) into the screens of
 * the Blueprint workspace. Like the helpers in page.ts they are ordinary
 * functions so they can be unit-tested, then inlined into the page with
 * toString(). Each must stand alone: no references outside its own body,
 * and no TypeScript-only syntax that survives compilation.
 */

/** The workspace screens, in sidebar order. Settings sits apart at the foot of the sidebar. */
export const WORKSPACE_NAV: ReadonlyArray<{ view: string; label: string }> = [
  { view: "overview", label: "Overview" },
  { view: "find_work", label: "Find work" },
  { view: "bids", label: "Bids" },
  { view: "projects", label: "Projects" },
  { view: "subs_vendors", label: "Subs & vendors" },
  { view: "schedule", label: "Schedule" },
  { view: "money", label: "Money" },
  { view: "closeout", label: "Closeout" },
];

/** The tabs of the Settings page: the owner dashboard's tools. */
export const SETTINGS_TABS: ReadonlyArray<{ tab: string; label: string }> = [
  { tab: "approvals", label: "Approvals" },
  { tab: "live", label: "Live log" },
  { tab: "runs", label: "Past runs" },
  { tab: "start", label: "Start a run" },
];

export interface Route {
  view: string;
  /** The Settings tab, when the view is settings. */
  tab?: string;
  /** The run id, when the view is one job. */
  runId?: string;
}

/**
 * Reads the page's location hash. "#bids" is a screen, "#settings/live" a
 * Settings tab, "#job/<run id>" one job. Anything else is the overview.
 */
export function parseRoute(hash: unknown): Route {
  const views = ["overview", "find_work", "bids", "projects", "subs_vendors", "schedule", "money", "closeout"];
  const tabs = ["approvals", "live", "runs", "start"];
  const raw = typeof hash === "string" ? hash.replace(/^#\/?/, "") : "";
  const slash = raw.indexOf("/");
  const head = slash < 0 ? raw : raw.slice(0, slash);
  const rest = slash < 0 ? "" : raw.slice(slash + 1);
  if (head === "settings") return { view: "settings", tab: tabs.includes(rest) ? rest : "approvals" };
  if (head === "job" && rest) {
    let runId = rest;
    try { runId = decodeURIComponent(rest); } catch { /* keep it as written */ }
    return { view: "job", runId };
  }
  return { view: views.includes(head) ? head : "overview" };
}

/** The hash for a route; the inverse of parseRoute. */
export function routeHash(route: Route): string {
  if (route.view === "settings") return "#settings/" + (route.tab || "approvals");
  if (route.view === "job") return "#job/" + encodeURIComponent(route.runId || "");
  return "#" + route.view;
}

/** A lifecycle stage as the owner reads it. */
export function stageLabel(stage: unknown): string {
  const labels: Record<string, string> = {
    find: "Find", research: "Research", bid: "Bid", award: "Award", subs: "Subs",
    schedule: "Build", bill: "Bill", pay: "Get paid", closeout: "Closeout",
  };
  const s = String(stage ?? "");
  return Object.prototype.hasOwnProperty.call(labels, s) ? labels[s]! : s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/** Where a job stands, in words, and how it is coloured. */
export function jobStatus(job: { status?: unknown; finished?: unknown }): { text: string; tone: "success" | "danger" | "warning" | "info" | "neutral" } {
  if (job.status === "closed") return { text: "Closed", tone: "success" };
  if (job.status === "lost") return { text: "Lost", tone: "danger" };
  if (job.status === "passed") return { text: "Passed", tone: "neutral" };
  if (job.finished === true) return { text: "Stopped", tone: "warning" };
  return { text: "In progress", tone: "info" };
}

/** A job's name: its title, else its notice id, else the run id. */
export function jobName(job: { title?: unknown; noticeId?: unknown; runId?: unknown }): string {
  for (const v of [job.title, job.noticeId, job.runId]) if (typeof v === "string" && v.trim()) return v.trim();
  return "Untitled job";
}

/** An agent's role in words: "project_manager" is "Project manager". */
export function roleLabel(role: unknown): string {
  const text = String(role ?? "").replace(/_/g, " ").trim();
  if (text.toLowerCase() === "hr") return "HR";
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Agent";
}

/** The jobs a screen lists. Each screen shows the jobs that have reached its part of the work. */
export function jobsForView(view: string, jobs: readonly any[]): any[] {
  const all = Array.isArray(jobs) ? jobs.filter((j) => j && typeof j === "object") : [];
  const late = ["bill", "pay", "closeout"];
  switch (view) {
    case "find_work": return all.filter((j) => j.noticeId);
    case "bids": return all.filter((j) => j.estimateUsd !== null && j.estimateUsd !== undefined || (j.bidStatus && j.bidStatus !== "none"));
    case "projects": return all.filter((j) => j.contractUsd !== null && j.contractUsd !== undefined);
    case "schedule": return all.filter((j) => Array.isArray(j.schedule) && j.schedule.length > 0);
    case "money": return all.filter((j) => (j.contractUsd ?? null) !== null || j.invoicedUsd || j.receivedUsd || j.paidOutUsd);
    case "closeout": return all.filter((j) => j.status === "closed" || late.includes(j.stage));
    default: return all;
  }
}

/** Money across jobs. Contract value includes accepted change orders; profit counts only jobs that have one. */
export function moneyTotals(jobs: readonly any[]): { contractUsd: number; costUsd: number; invoicedUsd: number; receivedUsd: number; owedToUsUsd: number; paidOutUsd: number; profitUsd: number } {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const t = { contractUsd: 0, costUsd: 0, invoicedUsd: 0, receivedUsd: 0, owedToUsUsd: 0, paidOutUsd: 0, profitUsd: 0 };
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j || typeof j !== "object" || j.status === "lost" || j.status === "passed") continue;
    if (typeof j.contractUsd === "number") t.contractUsd += n(j.contractUsd) + n(j.changeOrdersUsd);
    t.costUsd += n(j.costUsd);
    t.invoicedUsd += n(j.invoicedUsd);
    t.receivedUsd += n(j.receivedUsd);
    t.paidOutUsd += n(j.paidOutUsd);
    t.profitUsd += n(j.profitUsd);
  }
  t.owedToUsUsd = Math.max(0, t.invoicedUsd - t.receivedUsd);
  return t;
}

/**
 * Every subcontractor that quoted, across jobs: how many quotes it sent, how
 * many were picked, and the value of the picked ones. Sorted by that value.
 */
export function subsFromJobs(jobs: readonly any[]): Array<{ name: string; trades: string[]; quotes: number; selected: number; selectedUsd: number; jobs: number }> {
  const by = new Map<string, { name: string; trades: string[]; quotes: number; selected: number; selectedUsd: number; runs: Set<string> }>();
  for (const j of Array.isArray(jobs) ? jobs : []) {
    for (const q of j && Array.isArray(j.quotes) ? j.quotes : []) {
      const name = typeof q.subcontractor === "string" && q.subcontractor ? q.subcontractor : "Unnamed";
      let s = by.get(name);
      if (!s) by.set(name, (s = { name, trades: [], quotes: 0, selected: 0, selectedUsd: 0, runs: new Set() }));
      if (q.trade && !s.trades.includes(q.trade)) s.trades.push(q.trade);
      s.quotes += 1;
      if (q.selected) { s.selected += 1; s.selectedUsd += typeof q.priceUsd === "number" ? q.priceUsd : 0; }
      s.runs.add(String(j.runId));
    }
  }
  return [...by.values()]
    .map((s) => ({ name: s.name, trades: s.trades, quotes: s.quotes, selected: s.selected, selectedUsd: s.selectedUsd, jobs: s.runs.size }))
    .sort((a, b) => b.selectedUsd - a.selectedUsd || b.quotes - a.quotes || a.name.localeCompare(b.name));
}

/**
 * A job's schedule as bars on one track: each line's offset and width as a
 * percentage of the longer of the contract and the plan.
 */
export function scheduleBars(job: { schedule?: unknown; contractDays?: unknown }): { totalDays: number; bars: Array<{ trade: string; startDay: number; days: number; left: number; width: number }> } {
  const lines = Array.isArray(job.schedule) ? job.schedule.filter((l) => l && typeof l === "object") : [];
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const end = lines.reduce((m: number, l: any) => Math.max(m, n(l.startDay) + n(l.days)), 0);
  const totalDays = Math.max(end, n(job.contractDays), 1);
  const pct = (v: number) => Math.round((v / totalDays) * 1000) / 10;
  return {
    totalDays,
    bars: lines.map((l: any) => ({ trade: String(l.trade ?? ""), startDay: n(l.startDay), days: n(l.days), left: pct(n(l.startDay)), width: pct(n(l.days)) })),
  };
}

/** A problem's id in words: "failed-inspection" is "Failed inspection". */
export function problemLabel(id: unknown): string {
  const text = String(id ?? "").replace(/[-_]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Problem";
}
