/**
 * The dashboard page: one self-contained HTML file with inline CSS and JS,
 * laid out as the Blueprint workspace of the customer site (web/src/design):
 * the same sidebar screens, filled from the runs' data (/api/workspace), with
 * the owner's tools (approvals, live log, past runs, starting a run) as tabs
 * of Settings. The colour values are copied from that design's tokens; a test
 * fails if they drift.
 *
 * Every value from a report or event is set with textContent, never as
 * HTML, because agents write much of that text.
 */

import { SETTINGS_TABS, WORKSPACE_NAV, jobName, jobStatus, jobsForView, moneyTotals, parseRoute, problemLabel, roleLabel, routeHash, scheduleBars, stageLabel, subsFromJobs } from "./views.js";

/* ── Helpers the page runs in the browser. They are written here as ordinary
      functions so they can be unit-tested, then inlined into the page with
      toString(). Each must stand alone: no references outside its own body. ── */

/** A gate's name as the owner should read it. */
export function gateLabel(gate: string): string {
  const labels: Record<string, string> = {
    hire_agent: "Hire",
    pursue_opportunity: "Pursue a project",
    submit_bid: "Submit a bid",
    sign_contract: "Sign the contract",
    sign_commitment: "Sign subcontracts",
    approve_change_order: "Change order",
    release_payment: "Release payments",
    submit_invoice: "Send the invoice",
    close_project: "Close the project",
  };
  if (Object.prototype.hasOwnProperty.call(labels, gate)) return labels[gate]!;
  const text = String(gate ?? "").replace(/_/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Approval";
}

/**
 * Splits one long summary into a headline sentence and the paragraphs after
 * it, for requests that carry no structured details.
 */
export function splitSummary(text: unknown): { lead: string; rest: string[] } {
  const all = typeof text === "string" ? text.trim() : "";
  if (!all) return { lead: "", rest: [] };
  // A sentence ends at . ! or ? followed by space and a capital, quote or bracket; "$1,200.50" and "e.g. x" do not split.
  const m = /^([\s\S]+?[.!?])\s+(?=[A-Z"“(])([\s\S]*)$/.exec(all);
  const lead = (m ? m[1]! : all).replace(/\s+/g, " ");
  const rest = (m ? m[2]! : "")
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return { lead, rest };
}

/** "$1,234" for a number, "" for anything else. */
export function formatMoney(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US") : "";
}

/** The simple fields of an event's payload as "key value" pairs; long text is cut and nested data left out. */
export function eventDetail(payload: unknown): Array<{ key: string; value: string }> {
  if (!payload || typeof payload !== "object") return [];
  const out: Array<{ key: string; value: string }> = [];
  for (const [key, raw] of Object.entries(payload as Record<string, unknown>)) {
    if (raw === null || raw === undefined || typeof raw === "object") continue;
    const text = String(raw);
    out.push({ key: key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase(), value: text.length > 120 ? text.slice(0, 120) + "…" : text });
    if (out.length === 6) break;
  }
  return out;
}

/** How a run's outcome is coloured: finished well, finished badly, or neither. */
export function outcomeTone(outcome: unknown): "success" | "danger" | "warning" {
  const o = String(outcome ?? "").toLowerCase();
  if (["closed", "completed", "awarded", "complete"].includes(o)) return "success";
  if (["incomplete", "lost", "interrupted", "failed"].includes(o)) return "danger";
  return "warning";
}

/** Blueprint colour tokens, as web/src/design/tokens.json defines them. */
export const DASHBOARD_COLORS: Readonly<Record<string, string>> = {
  bg: "#f4f6fa",
  surface: "#ffffff",
  "surface-sunk": "#e9edf4",
  line: "#d5dbe6",
  "line-strong": "#768296",
  ink: "#0f1b2d",
  "ink-muted": "#4d5a6e",
  brand: "#1d4ed8",
  "on-brand": "#ffffff",
  "brand-ink": "#1a43b8",
  "brand-soft": "#dbe6ff",
  accent: "#f59e0b",
  "on-accent": "#1f1400",
  shell: "#0b1a33",
  "shell-raised": "#16294a",
  "on-shell": "#f1f5fb",
  "on-shell-muted": "#a9b6cc",
  success: "#0b665f",
  "success-soft": "#d5f0ec",
  warning: "#8a5300",
  "warning-soft": "#fdecc8",
  danger: "#b42318",
  "danger-soft": "#fde4df",
};

const COLOR_VARS = Object.entries(DASHBOARD_COLORS)
  .map(([name, value]) => `--${name}:${value};`)
  .join(" ");

const FONT_FACES = [
  ["Archivo", 600, "archivo-600"],
  ["Archivo", 700, "archivo-700"],
  ["Archivo", 800, "archivo-800"],
  ["IBM Plex Sans", 400, "plex-sans-400"],
  ["IBM Plex Sans", 500, "plex-sans-500"],
  ["IBM Plex Sans", 600, "plex-sans-600"],
  ["IBM Plex Mono", 500, "plex-mono-500"],
]
  .map(([family, weight, file]) => `@font-face { font-family:"${family}"; font-weight:${weight}; font-style:normal; font-display:swap; src:url("/fonts/${file}.woff2") format("woff2"); }`)
  .join("\n  ");

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Owner dashboard · Contracting.Bid</title>
<style>
  ${FONT_FACES}
  :root { ${COLOR_VARS}
    --font-display:"Archivo", "Arial Narrow", Arial, sans-serif; --font-sans:"IBM Plex Sans", system-ui, sans-serif; --font-mono:"IBM Plex Mono", ui-monospace, Menlo, monospace;
    --r:8px; --shadow-card:0 1px 2px rgba(15, 27, 45, 0.08); }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body { margin:0; font:15px/24px var(--font-sans); background:var(--bg); color:var(--ink); -webkit-font-smoothing:antialiased; }
  h1, h2, h3, p, dl, dd { margin:0; }
  [hidden] { display:none !important; }

  .shell { display:grid; grid-template-columns:232px minmax(0, 1fr); min-height:100vh; }
  .side { background:var(--shell); color:var(--on-shell-muted); padding:24px 16px; display:flex; flex-direction:column; gap:24px; position:sticky; top:0; height:100vh; }
  .wordmark { font:800 20px/24px var(--font-display); letter-spacing:-0.02em; color:var(--on-shell); padding:0 12px; }
  .wordmark b { color:var(--accent); font-weight:800; }
  .side-label { font:600 12px/16px var(--font-sans); letter-spacing:0.06em; text-transform:uppercase; padding:4px 12px 0; }
  nav { display:flex; flex-direction:column; gap:4px; }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  .badge { min-width:22px; padding:0 6px; border-radius:999px; background:var(--accent); color:var(--on-accent); font:600 12px/20px var(--font-mono); text-align:center; }
  .side-foot { margin-top:auto; border-top:1px solid var(--shell-raised); padding:16px 12px 0; display:grid; gap:8px; font-size:13px; line-height:20px; }
  .side-foot #who { color:var(--on-shell); font-weight:600; }
  .conn { display:inline-flex; align-items:center; gap:8px; }
  .conn::before { content:""; width:8px; height:8px; border-radius:999px; background:var(--on-shell-muted); }
  .conn.live::before { background:var(--accent); }
  .side-foot button { justify-self:start; background:none; border:1px solid var(--on-shell-muted); color:var(--on-shell); font:600 13px/20px var(--font-sans); padding:4px 12px; border-radius:var(--r); cursor:pointer; }
  .side-foot button:hover { border-color:var(--on-shell); }

  main { padding:24px 32px 48px; display:grid; gap:24px; align-content:start; min-width:0; }
  section { display:grid; gap:24px; align-content:start; min-width:0; }
  .pagehead { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
  h1 { font:700 28px/34px var(--font-display); letter-spacing:-0.01em; }
  .stack { display:grid; gap:16px; }
  .card { background:var(--surface); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow-card); padding:24px; min-width:0; display:grid; gap:16px; align-content:start; }
  .card-h { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; }
  h2 { font:600 20px/28px var(--font-display); }
  h3 { font:600 17px/24px var(--font-display); }
  .muted { color:var(--ink-muted); }
  .small { font-size:13px; line-height:20px; }
  .label { font:600 12px/16px var(--font-sans); letter-spacing:0.06em; text-transform:uppercase; color:var(--ink-muted); }
  .num { font:500 14px/20px var(--font-mono); font-variant-numeric:tabular-nums; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .grow { flex:1; }

  .btn { font:600 14px/20px var(--font-sans); height:40px; padding:0 16px; border-radius:var(--r); border:1px solid var(--line-strong); background:var(--surface); color:var(--ink); cursor:pointer; white-space:nowrap; }
  .btn:hover { border-color:var(--ink); }
  a.btn { display:inline-flex; align-items:center; text-decoration:none; }
  .btn.primary { background:var(--brand); border-color:var(--brand); color:var(--on-brand); }
  .btn.primary:hover { filter:brightness(0.94); }
  .btn.ghost { border-color:transparent; background:none; color:var(--brand-ink); padding-left:0; }
  .btn.reject { color:var(--danger); border-color:var(--danger); }
  .btn:disabled { opacity:0.5; cursor:not-allowed; }
  .btn:focus-visible, input:focus-visible, select:focus-visible, .clickable:focus-visible, summary:focus-visible { outline:2px solid var(--brand); outline-offset:2px; }
  .side :focus-visible { outline-color:var(--on-shell); }
  select, input[type=text], input[type=password] { font:inherit; height:40px; padding:0 12px; border:1px solid var(--line-strong); border-radius:var(--r); background:var(--surface); color:var(--ink); max-width:100%; }
  input[type=text], input[type=password] { flex:1; min-width:180px; }
  input::placeholder { color:var(--ink-muted); }
  input[type=checkbox] { width:18px; height:18px; margin:0; accent-color:var(--brand); flex:none; }
  label.check { display:flex; gap:12px; align-items:center; }

  .pill { display:inline-flex; align-items:center; font:600 12px/20px var(--font-sans); padding:0 8px; border-radius:999px; background:var(--surface-sunk); color:var(--ink); white-space:nowrap; }
  .pill.success { background:var(--success-soft); color:var(--success); }
  .pill.warning { background:var(--warning-soft); color:var(--warning); }
  .pill.danger { background:var(--danger-soft); color:var(--danger); }
  .pill.info { background:var(--brand-soft); color:var(--brand-ink); }

  .approval-top { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .approval-top .amount { margin-left:auto; font:500 22px/28px var(--font-mono); letter-spacing:-0.02em; }
  .approval-title { display:grid; gap:2px; }
  .facts { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:0; border-top:1px solid var(--line-strong); border-left:1px solid var(--line); }
  .facts > div { padding:12px 16px; border-right:1px solid var(--line); border-bottom:1px solid var(--line); display:grid; gap:4px; min-width:0; }
  .facts dd { font:500 15px/22px var(--font-mono); overflow-wrap:anywhere; }
  .notes { display:grid; gap:16px; }
  .note { display:grid; gap:4px; }
  .note p, .prose p { max-width:76ch; white-space:pre-line; overflow-wrap:anywhere; }
  .prose { display:grid; gap:8px; }
  .items { display:grid; border-top:1px solid var(--line-strong); }
  .items label { display:grid; grid-template-columns:auto minmax(0, 1fr) auto; gap:12px; align-items:center; padding:12px 0; border-bottom:1px solid var(--line); }
  .items .small { display:block; }
  .decide { border-top:1px solid var(--line); padding-top:16px; }
  .error { color:var(--danger); font-weight:600; font-size:14px; }
  .error:empty { display:none; }

  .empty { display:grid; gap:8px; justify-items:center; text-align:center; padding:32px 16px; }
  .empty p { color:var(--ink-muted); max-width:44ch; }

  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:13px; line-height:20px; }
  th, td { text-align:left; padding:12px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font:600 12px/16px var(--font-sans); letter-spacing:0.06em; text-transform:uppercase; color:var(--ink-muted); border-bottom-color:var(--line-strong); }
  td.num, th.num { text-align:right; white-space:nowrap; }
  th.num { font:600 12px/16px var(--font-sans); }
  td.strong { font-weight:600; }
  tr:last-child td { border-bottom:0; }
  .clickable { cursor:pointer; }
  .clickable:hover td { background:var(--bg); }

  .kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:16px; }
  .kpi { background:var(--surface); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow-card); padding:16px; display:grid; gap:8px; min-width:0; }
  .kpi b { font:500 24px/32px var(--font-mono); letter-spacing:-0.02em; overflow-wrap:anywhere; }

  .events { display:grid; }
  .ev { display:grid; grid-template-columns:56px minmax(0, 220px) minmax(0, 150px) minmax(0, 1fr); gap:12px; padding:8px 0; border-bottom:1px solid var(--line); font-size:13px; line-height:20px; align-items:start; }
  .ev:last-child { border-bottom:0; }
  .ev .seq { color:var(--ink-muted); }
  .ev .type { font-weight:600; overflow-wrap:anywhere; }
  .ev .run { display:block; font-weight:400; color:var(--ink-muted); }
  .ev .kv { display:flex; flex-wrap:wrap; gap:4px 16px; min-width:0; }
  .ev .kv span { overflow-wrap:anywhere; }
  .ev .kv i { font-style:normal; color:var(--ink-muted); }
  .output { font:500 12px/20px var(--font-mono); white-space:pre-wrap; overflow-wrap:anywhere; background:var(--surface-sunk); border-radius:var(--r); padding:12px 16px; margin-top:8px; }
  details summary { cursor:pointer; font-size:14px; padding:8px 0; }
  .running { display:grid; gap:2px; padding:12px 0; border-top:1px solid var(--line); }

  body.signed-out .side { display:none; }
  body.signed-out .shell { grid-template-columns:minmax(0, 1fr); }
  .login-wrap { min-height:calc(100vh - 72px); display:grid; place-items:center; }
  form.login { width:100%; max-width:400px; }
  form.login .wordmark { color:var(--ink); padding:0; }
  form.login .wordmark b { color:var(--brand-ink); }
  form.login .field { display:grid; gap:4px; }
  form.login .field span { font:600 13px/20px var(--font-sans); }
  form.login input { width:100%; height:44px; }
  form.login .btn { height:48px; }

  .side nav a, .side .foot-link { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 12px; color:inherit; font:500 14px/24px var(--font-sans); text-decoration:none; border-radius:var(--r); }
  .side nav a:hover, .side .foot-link:hover { background:var(--shell-raised); color:var(--on-shell); }
  .side nav a[aria-current] { background:var(--shell-raised); color:var(--on-shell); box-shadow:inset 3px 0 0 var(--accent); }
  .side .foot-link[aria-current] { color:var(--on-shell); font-weight:600; }
  .side a:focus-visible { outline:2px solid var(--on-shell); outline-offset:2px; }
  .tabs { display:flex; gap:4px; border-bottom:1px solid var(--line-strong); overflow-x:auto; }
  .tabs a { display:inline-flex; align-items:center; gap:8px; padding:8px 16px; color:var(--ink-muted); font:600 14px/24px var(--font-sans); text-decoration:none; white-space:nowrap; border-bottom:3px solid transparent; margin-bottom:-1px; }
  .tabs a:hover { color:var(--ink); }
  .tabs a[aria-current] { color:var(--ink); border-bottom-color:var(--brand); }
  .tabs a:focus-visible, a.link:focus-visible { outline:2px solid var(--brand); outline-offset:2px; }
  a.link { color:var(--brand-ink); font-weight:600; text-decoration:none; }
  a.link:hover { text-decoration:underline; }
  .stepper { display:grid; grid-template-columns:repeat(9, minmax(0, 1fr)); gap:4px; }
  .stepper span { font:600 11px/16px var(--font-sans); letter-spacing:0.04em; text-transform:uppercase; padding:8px 4px 0; border-top:4px solid var(--line); color:var(--ink-muted); text-align:center; overflow-wrap:anywhere; }
  .stepper span.done { border-top-color:var(--brand); color:var(--ink); }
  .stepper span.now { border-top-color:var(--accent); color:var(--ink); }
  .grid2 { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:24px; }
  .track { position:relative; height:28px; background:var(--surface-sunk); border-radius:var(--r); }
  .track i { position:absolute; top:4px; bottom:4px; background:var(--brand); border-radius:4px; min-width:4px; }
  .gantt { display:grid; grid-template-columns:minmax(90px, 160px) minmax(0, 1fr) auto; gap:8px 12px; align-items:center; }
  .kpi.urgent { border-color:var(--accent); box-shadow:inset 4px 0 0 var(--accent), var(--shadow-card); }
  .task { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; padding:12px 0; border-bottom:1px solid var(--line); }
  .task:last-child { border-bottom:0; }

  @media (max-width:820px) {
    .shell { grid-template-columns:minmax(0, 1fr); }
    .side { position:static; height:auto; padding:16px; gap:12px; }
    nav { flex-direction:row; overflow-x:auto; }
    .side-foot { margin-top:0; grid-auto-flow:column; justify-content:start; align-items:center; gap:16px; padding:12px 12px 0; }
    main { padding:16px; }
    .card { padding:16px; }
    .ev { grid-template-columns:44px minmax(0, 1fr); }
    .ev .actor, .ev .kv { grid-column:2; }
    .approval-top .amount { margin-left:0; width:100%; }
    nav a, .side .foot-link { white-space:nowrap; }
    .kpis { grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px; }
    .task .grow { flex-basis:100%; order:-1; }
    .stepper { grid-template-columns:repeat(3, minmax(0, 1fr)); }
    .gantt { grid-template-columns:minmax(0, 1fr) auto; }
    .gantt .track { grid-column:1 / -1; }
  }
</style>
</head>
<body class="signed-out">
<div class="shell">
  <aside class="side">
    <div>
      <div class="wordmark">Contracting<b>.Bid</b></div>
      <div class="side-label">Workspace</div>
    </div>
    <nav id="nav" aria-label="Workspace" hidden>
${WORKSPACE_NAV.map((n) => `      <a href="#${n.view}" data-view="${n.view}">${n.label.replace("&", "&amp;")}</a>`).join("\n")}
    </nav>
    <div class="side-foot">
      <a id="settingsLink" class="foot-link" href="#settings/approvals" data-view="settings" hidden><span>Settings</span><span id="count" class="badge" hidden>0</span></a>
      <span id="conn" class="conn"></span>
      <span id="stackBadge" class="pill" style="align-self:flex-start; justify-self:start" hidden></span>
      <span id="who"></span>
      <button id="logout" hidden>Sign out</button>
    </div>
  </aside>
  <main>
    <section id="login" hidden></section>
${WORKSPACE_NAV.map((n) => `    <section id="v-${n.view}" data-screen="${n.view}" hidden>
      <div class="pagehead"><h1>${n.label.replace("&", "&amp;")}</h1><span class="pill">From your runs</span></div>
      <div class="stack body"></div>
    </section>`).join("\n")}
    <section id="v-job" data-screen="job" hidden>
      <div class="stack body"></div>
    </section>
    <section id="v-settings" data-screen="settings" hidden>
      <div class="pagehead"><h1>Settings</h1></div>
      <div class="tabs" role="tablist" aria-label="Settings">
${SETTINGS_TABS.map((t) => `        <a href="#settings/${t.tab}" data-tab="${t.tab}"${t.tab === "start" ? ' id="startTab" hidden' : ""}>${t.label}${t.tab === "approvals" ? ' <span id="tabCount" class="badge" hidden>0</span>' : ""}</a>`).join("\n")}
      </div>
      <div id="approvals" hidden>
        <h2 class="sr">Approvals</h2>
        <div id="approvalsBody" class="stack"></div>
      </div>
      <div id="live" hidden>
        <div class="card"><div class="card-h"><h2>Live log</h2></div><div id="log" class="events"></div><div id="logEmpty" class="empty"><h3>Nothing yet</h3><p>Events from a running simulation appear here as they happen.</p></div></div>
      </div>
      <div id="runs" hidden>
        <div id="runsBody" class="stack"></div>
      </div>
      <div id="start" hidden>
        <div id="startBody" class="stack"></div>
      </div>
    </section>
  </main>
</div>
<script>
(() => {
  ${gateLabel.toString()}
  ${splitSummary.toString()}
  ${formatMoney.toString()}
  ${eventDetail.toString()}
  ${outcomeTone.toString()}
  ${parseRoute.toString()}
  ${routeHash.toString()}
  ${stageLabel.toString()}
  ${jobStatus.toString()}
  ${jobName.toString()}
  ${roleLabel.toString()}
  ${jobsForView.toString()}
  ${moneyTotals.toString()}
  ${subsFromJobs.toString()}
  ${scheduleBars.toString()}
  ${problemLabel.toString()}
  const STAGES = ["find", "research", "bid", "award", "subs", "schedule", "bill", "pay", "closeout"];

  let csrf = "";
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const money = formatMoney;
  const empty = (title, text) => el("div", { class: "card" }, el("div", { class: "empty" }, el("h3", { text: title }), el("p", { text })));
  const api = async (path, init = {}) => {
    const res = await fetch(path, { ...init, credentials: "same-origin", headers: { "x-requested-with": "dashboard", "x-csrf-token": csrf, "content-type": "application/json", ...(init.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "/api/login") { showLogin("Your session ended. Sign in again."); throw new Error("Sign in first"); }
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  };
  let pending = [];
  const events = [];
  const TABS = ["approvals", "live", "runs", "start"];
  let launch = null;
  let launchNote = "";
  let work = { jobs: [], stats: null };
  let route = parseRoute(location.hash);
  let signed = false;

  // ── Routing: the hash names the screen, so the back button and links work. ──
  function show() {
    route = parseRoute(location.hash);
    if (!signed) return;
    const navView = route.view === "job" ? "projects" : route.view;
    document.querySelectorAll(".side a[data-view]").forEach((a) => { if (a.dataset.view === navView) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    document.querySelectorAll("main > section[data-screen]").forEach((sec) => { sec.hidden = sec.dataset.screen !== route.view; });
    if (route.view === "settings") {
      const tab = route.tab === "start" && !launch ? "approvals" : route.tab;
      document.querySelectorAll(".tabs a").forEach((a) => { if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
      for (const id of TABS) $(id).hidden = id !== tab;
      if (tab === "runs") showRuns();
      if (tab === "start") renderStart();
    } else renderWork();
  }
  window.addEventListener("hashchange", show);

  // ── The workspace screens, filled from /api/workspace. ──
  let workTimer = null;
  async function loadWork() {
    try { work = await api("/api/workspace"); } catch (e) { work = { jobs: [], stats: null, error: e.message }; }
    if (signed && route.view !== "settings") renderWork();
  }
  // Job events arrive in bursts; refresh once they settle.
  const refreshWork = () => { clearTimeout(workTimer); workTimer = setTimeout(loadWork, 600); };

  const statusPill = (j) => { const s = jobStatus(j); return el("span", { class: "pill " + s.tone, text: s.text }); };
  const jobLink = (j) => el("a", { class: "link", href: routeHash({ view: "job", runId: j.runId }), text: jobName(j) });
  const kpi = (label, value, cls) => el("div", { class: "kpi" + (cls ? " " + cls : "") }, el("span", { class: "label", text: label }), el("b", { text: String(value) }));
  const card = (title, ...kids) => el("div", { class: "card" }, title ? el("div", { class: "card-h" }, el("h2", { text: title })) : null, ...kids);
  function table(cols, rows) {
    const t = el("table", {}, el("tr", {}, ...cols.map((c) => el("th", { class: c.num ? "num" : "", text: c.label }))));
    for (const r of rows) t.append(el("tr", {}, ...cols.map((c) => { const v = c.value(r); return el("td", { class: c.num ? "num" : "" }, v == null ? "" : typeof v === "object" ? v : String(v)); })));
    return el("div", { class: "table-wrap" }, t);
  }
  const noJobs = (what) => empty("Nothing here yet", what + " Start a run under Settings and it fills in as the agents work.");
  const stepper = (stage) => { const i = STAGES.indexOf(stage); return el("div", { class: "stepper", "aria-label": "Stage: " + stageLabel(stage) }, ...STAGES.map((s, k) => el("span", { class: k < i ? "done" : k === i ? "now" : "", text: stageLabel(s) }))); };

  const SCREENS = {
    overview(jobs) {
      const s = work.stats || {};
      const active = jobs.filter((j) => j.status === "active" && !j.finished);
      const t = moneyTotals(jobs);
      const out = [el("div", { class: "kpis" },
        kpi("Needs you", pending.length, pending.length ? "urgent" : ""), kpi("Jobs in progress", active.length),
        kpi("Bids awaiting award", (s.bidsAwaiting || 0) + (s.bidsAwaitingUsd ? " · " + money(s.bidsAwaitingUsd) : "")),
        kpi("Awarded jobs", s.awardedJobs || 0), kpi("Profit", money(t.profitUsd)))];
      const tasks = card("Needs you");
      if (!pending.length) tasks.append(el("p", { class: "muted", text: "Nothing is waiting for you. When an agent needs a decision, it shows here." }));
      for (const r of pending) tasks.append(el("div", { class: "task" }, el("span", { class: "pill info", text: gateLabel(r.gate) }), el("span", { class: "grow", text: splitSummary(r.summary).lead || gateLabel(r.gate) }),
        r.amountUsd !== undefined ? el("span", { class: "num", text: money(r.amountUsd) }) : null, el("a", { class: "btn primary", href: "#settings/approvals", text: "Review" })));
      out.push(tasks);
      if (!jobs.length) { out.push(noJobs("Your jobs appear here.")); return out; }
      out.push(card("Your jobs", table([
        { label: "Job", value: jobLink }, { label: "Agency", value: (j) => j.agency || "" }, { label: "Stage", value: (j) => stageLabel(j.stage) },
        { label: "Status", value: statusPill }, { label: "Contract", num: true, value: (j) => money(j.contractUsd) }, { label: "Profit", num: true, value: (j) => money(j.profitUsd) },
      ], jobs)));
      return out;
    },
    find_work(jobs) {
      if (!jobs.length) return [noJobs("Projects the President looked at appear here.")];
      return [card("Projects looked at", table([
        { label: "Notice", value: (j) => j.noticeId }, { label: "Project", value: jobLink }, { label: "Agency", value: (j) => j.agency || "" },
        { label: "Decision", value: (j) => el("span", { class: "pill " + (j.status === "passed" ? "" : j.stage === "find" ? "warning" : "success"), text: j.status === "passed" ? "Passed" : j.stage === "find" ? "Deciding" : "Pursued" }) },
      ], jobs))];
    },
    bids(jobs) {
      if (!jobs.length) return [noJobs("Bids the Estimator prices appear here.")];
      const tone = { none: "warning", submitted: "info", won: "success", lost: "danger" };
      const word = { none: "Pricing", submitted: "Submitted", won: "Won", lost: "Lost" };
      return [card("Bids", table([
        { label: "Job", value: jobLink }, { label: "Quotes in", value: (j) => j.trades.filter((t) => j.quotes.some((q) => q.trade === t)).length + " of " + j.trades.length + " trades" },
        { label: "Estimate", num: true, value: (j) => money(j.estimateUsd) }, { label: "Bid", num: true, value: (j) => money(j.bidUsd) },
        { label: "Status", value: (j) => el("span", { class: "pill " + (tone[j.bidStatus] || ""), text: word[j.bidStatus] || j.bidStatus }) },
      ], jobs))];
    },
    projects(jobs) {
      if (!jobs.length) return [noJobs("Jobs with a signed contract appear here.")];
      return [card("Projects", table([
        { label: "Job", value: jobLink }, { label: "Stage", value: (j) => stageLabel(j.stage) }, { label: "Contract", num: true, value: (j) => money(j.contractUsd) },
        { label: "Change orders", num: true, value: (j) => money(j.changeOrdersUsd) }, { label: "Cost", num: true, value: (j) => money(j.costUsd) },
        { label: "Problems", num: true, value: (j) => j.problems.filter((p) => p.resolved).length + " of " + j.problems.length + " solved" },
        { label: "Days", num: true, value: (j) => (j.contractDays ? j.contractDays + " contract" : "") + (j.daysLate ? ", " + j.daysLate + " late" : "") }, { label: "Status", value: statusPill },
      ], jobs))];
    },
    subs_vendors(jobs) {
      const subs = subsFromJobs(jobs);
      if (!subs.length) return [noJobs("Subcontractors that send quotes appear here.")];
      return [card("Subcontractors", table([
        { label: "Name", value: (s) => s.name }, { label: "Trades", value: (s) => s.trades.join(", ") }, { label: "Quotes", num: true, value: (s) => s.quotes },
        { label: "Picked", num: true, value: (s) => s.selected }, { label: "Picked value", num: true, value: (s) => money(s.selectedUsd) }, { label: "Jobs", num: true, value: (s) => s.jobs },
      ], subs))];
    },
    schedule(jobs) {
      if (!jobs.length) return [noJobs("Schedules the Scheduler sets appear here.")];
      return jobs.map((j) => card(null, el("div", { class: "card-h" }, jobLink(j), el("span", { class: "muted small" }, (j.contractDays ? j.contractDays + "-day contract" : ""))), gantt(j)));
    },
    money(jobs) {
      const t = moneyTotals(jobs);
      const out = [el("div", { class: "kpis" }, kpi("Contract value", money(t.contractUsd)), kpi("Invoiced", money(t.invoicedUsd)), kpi("Received", money(t.receivedUsd)),
        kpi("Owed to you", money(t.owedToUsUsd)), kpi("Paid to subs", money(t.paidOutUsd)), kpi("Profit", money(t.profitUsd)))];
      if (!jobs.length) { out.push(noJobs("Money in and out of each job appears here.")); return out; }
      out.push(card("By job", table([
        { label: "Job", value: jobLink }, { label: "Contract", num: true, value: (j) => money(j.contractUsd === null ? null : j.contractUsd + j.changeOrdersUsd) },
        { label: "Cost", num: true, value: (j) => money(j.costUsd) }, { label: "Invoiced", num: true, value: (j) => money(j.invoicedUsd) },
        { label: "Received", num: true, value: (j) => money(j.receivedUsd) }, { label: "Paid out", num: true, value: (j) => money(j.paidOutUsd) }, { label: "Profit", num: true, value: (j) => money(j.profitUsd) },
      ], jobs)));
      return out;
    },
    closeout(jobs) {
      if (!jobs.length) return [noJobs("Jobs being billed and closed appear here.")];
      return [card("Closeout", table([
        { label: "Job", value: jobLink }, { label: "Stage", value: (j) => stageLabel(j.stage) }, { label: "Invoiced", num: true, value: (j) => money(j.invoicedUsd) },
        { label: "Received", num: true, value: (j) => money(j.receivedUsd) }, { label: "Paid out", num: true, value: (j) => money(j.paidOutUsd) },
        { label: "Cash profit", num: true, value: (j) => money(j.profitUsd) }, { label: "Days late", num: true, value: (j) => j.daysLate == null ? "" : j.daysLate }, { label: "Status", value: statusPill },
      ], jobs))];
    },
  };

  function gantt(j) {
    const g = scheduleBars(j);
    if (!g.bars.length) return el("p", { class: "muted small", text: "Not scheduled yet." });
    const box = el("div", { class: "gantt" });
    for (const b of g.bars) {
      const bar = el("i", {});
      bar.style.left = b.left + "%"; bar.style.width = b.width + "%";
      box.append(el("span", { class: "strong", text: b.trade }), el("div", { class: "track", title: "Day " + b.startDay + " for " + b.days + " days" }, bar), el("span", { class: "num muted", text: "day " + b.startDay + "–" + (b.startDay + b.days) }));
    }
    return box;
  }

  function jobScreen(j) {
    if (!j) return [el("div", {}, el("a", { class: "btn ghost", href: "#projects", text: "← Projects" })), empty("Job not found", "This run is no longer in the workspace.")];
    const facts = [["Run", j.runId], ["Seed", j.seed], ["Notice", j.noticeId], ["Agency", j.agency], ["Estimate", money(j.estimateUsd)], ["Bid", money(j.bidUsd)],
      ["Contract", money(j.contractUsd)], ["Change orders", money(j.changeOrdersUsd)], ["Cost", money(j.costUsd)], ["Invoiced", money(j.invoicedUsd)],
      ["Received", money(j.receivedUsd)], ["Paid out", money(j.paidOutUsd)], ["Profit", money(j.profitUsd)], ["Days late", j.daysLate]].filter((f) => f[1] !== null && f[1] !== undefined && f[1] !== "");
    const out = [
      el("div", {}, el("a", { class: "btn ghost", href: "#projects", text: "← Projects" })),
      el("div", { class: "pagehead" }, el("h1", { text: jobName(j) }), statusPill(j)),
      card(null, stepper(j.stage), el("dl", { class: "facts" }, ...facts.map((f) => el("div", {}, el("dt", { class: "label", text: f[0] }), el("dd", { text: String(f[1]) }))))),
    ];
    if (j.tasks.length) out.push(card("Needs you", ...j.tasks.map((t) => el("div", { class: "task" }, el("span", { class: "pill info", text: gateLabel(t.gate) }), el("span", { class: "grow", text: splitSummary(t.summary).lead }), el("a", { class: "btn primary", href: "#settings/approvals", text: "Review" })))));
    const grid = el("div", { class: "grid2" });
    if (j.quotes.length) grid.append(card("Quotes", table([{ label: "Trade", value: (q) => q.trade }, { label: "Subcontractor", value: (q) => q.subcontractor }, { label: "Price", num: true, value: (q) => money(q.priceUsd) }, { label: "", value: (q) => q.selected ? el("span", { class: "pill success", text: "Picked" }) : "" }], j.quotes)));
    if (j.schedule.length) grid.append(card("Schedule", gantt(j)));
    if (j.problems.length || j.injected.length) grid.append(card("Problems on site", table([{ label: "Problem", value: (p) => problemLabel(p.id) }, { label: "Trade", value: (p) => p.trade || "" }, { label: "Outcome", value: (p) => el("span", { class: "pill " + (p.resolved ? "success" : "danger"), text: p.resolved ? (p.choice ? problemLabel(p.choice) : "Solved") : "Open" }) }, { label: "Cost", num: true, value: (p) => p.costUsd ? money(p.costUsd) : "" }, { label: "Days", num: true, value: (p) => p.days || "" }], j.problems.length ? j.problems : j.injected.map((id) => ({ id, trade: null, resolved: false, choice: null, costUsd: 0, days: 0 })))));
    if (j.team.length) grid.append(card("Team", table([{ label: "Agent", value: (a) => roleLabel(a.role) + " #" + a.agentId }, { label: "Reports to", value: (a) => { const m = j.team.find((x) => x.agentId === a.managerId); return m ? roleLabel(m.role) : "Owner"; } }, { label: "Hired by", value: (a) => a.hiredBy }, { label: "Budget", num: true, value: (a) => a.budgetUsd == null ? "" : "$" + a.budgetUsd.toFixed(2) }], j.team)));
    if (j.decisions.length) grid.append(card("Your decisions", table([{ label: "#", num: true, value: (d) => d.approvalId }, { label: "Decision", value: (d) => gateLabel(d.gate) }, { label: "Outcome", value: (d) => el("span", { class: "pill " + (d.status === "approved" ? "success" : d.status === "rejected" ? "danger" : "warning"), text: d.status.charAt(0).toUpperCase() + d.status.slice(1) }) }, { label: "Reason", value: (d) => d.reason || "" }], j.decisions)));
    if (grid.childNodes.length) out.push(grid);
    return out;
  }

  function renderWork() {
    if (route.view === "settings") return;
    const sec = $("v-" + route.view);
    if (!sec) return;
    const box = sec.querySelector(".body");
    const jobs = Array.isArray(work.jobs) ? work.jobs : [];
    let parts;
    if (route.view === "job") parts = jobScreen(jobs.find((j) => j.runId === route.runId));
    else parts = SCREENS[route.view](jobsForView(route.view, jobs));
    if (work.error) parts.unshift(el("div", { class: "card error", text: work.error }));
    box.replaceChildren(...parts);
  }

  function renderApprovals() {
    const box = $("approvalsBody");
    box.replaceChildren();
    for (const id of ["count", "tabCount"]) { $(id).hidden = pending.length === 0; $(id).textContent = String(pending.length); }
    if (signed && route.view === "overview") renderWork();
    if (pending.length === 0) {
      box.append(empty("Nothing is waiting for you", "When a running simulation needs a decision, it appears here."));
      return;
    }
    for (const r of pending) box.append(approvalCard(r));
  }

  // The request's content: structured details when the run sent them, otherwise the summary split into a headline and paragraphs.
  function approvalBody(r) {
    const d = r.details;
    if (d && typeof d === "object" && typeof d.title === "string") {
      const parts = [el("div", { class: "approval-title" }, el("h2", { text: d.title }), d.subtitle ? el("p", { class: "muted small", text: String(d.subtitle) }) : null)];
      const facts = Array.isArray(d.facts) ? d.facts.filter((f) => f && f.label) : [];
      if (facts.length) parts.push(el("dl", { class: "facts" }, ...facts.map((f) => el("div", {}, el("dt", { class: "label", text: String(f.label) }), el("dd", { text: String(f.value == null ? "" : f.value) })))));
      const notes = Array.isArray(d.notes) ? d.notes.filter((n) => n && n.text) : [];
      if (notes.length) parts.push(el("div", { class: "notes" }, ...notes.map((n) => el("div", { class: "note" }, el("div", { class: "label", text: String(n.label || "Note") }), el("p", { text: String(n.text) })))));
      return parts;
    }
    const s = splitSummary(r.summary);
    return [el("div", { class: "prose" }, el("h2", { text: s.lead || gateLabel(r.gate) }), ...s.rest.map((p) => el("p", { text: p })))];
  }

  function approvalCard(r) {
    const err = el("div", { class: "error", role: "alert" });
    const reason = el("input", { type: "text", placeholder: "Reason (optional; shown to the agent)", "aria-label": "Reason" });
    const send = async (body) => {
      try {
        await api("/api/approvals/" + r.id, { method: "POST", body: JSON.stringify(body) });
        pending = pending.filter((p) => p.id !== r.id);
        renderApprovals();
      } catch (e) { err.textContent = e.message; }
    };
    const top = el("div", { class: "approval-top" },
      el("span", { class: "pill info", text: gateLabel(r.gate) }),
      el("span", { class: "muted small", text: "Request " + r.id + (r.number !== undefined ? " (number " + r.number + " in its run)" : "") + " from " + r.requestedBy + (r.runId ? " · " + r.runId : "") }),
      r.amountUsd !== undefined ? el("span", { class: "amount", text: money(r.amountUsd) }) : null);
    const card = el("div", { class: "card", "data-gate": r.gate }, top, ...approvalBody(r));
    if (r.items && r.items.length) {
      const list = el("div", { class: "items" });
      const boxes = r.items.map((i) => {
        const cb = el("input", { type: "checkbox" });
        cb.checked = true;
        cb.value = i.id;
        list.append(el("label", {}, cb, el("span", {}, el("strong", { text: i.label }), el("span", { class: "muted small", text: i.id })), el("span", { class: "num", text: money(i.amountUsd) })));
        return cb;
      });
      card.append(list, el("div", { class: "row decide" },
        el("button", { class: "btn primary", text: "Approve all", onclick: () => send({ approve: true, reason: reason.value }) }),
        el("button", { class: "btn", text: "Approve checked only", onclick: () => {
          const items = boxes.filter((b) => b.checked).map((b) => b.value);
          send(items.length ? { approve: true, items, reason: reason.value } : { approve: false, reason: reason.value || "No items approved" });
        } }),
        el("button", { class: "btn reject", text: "Reject", onclick: () => send({ approve: false, reason: reason.value }) }),
        reason));
    } else {
      card.append(el("div", { class: "row decide" },
        el("button", { class: "btn primary", text: "Approve", onclick: () => send({ approve: true, reason: reason.value }) }),
        el("button", { class: "btn reject", text: "Reject", onclick: () => send({ approve: false, reason: reason.value }) }),
        reason));
    }
    card.append(err);
    return card;
  }

  function eventRow(e, withRun) {
    const parts = String(e.runId || "").split("-");
    const run = withRun && parts.length > 1 ? parts[0] + " " + parts[parts.length - 1] : "";
    return el("div", { class: "ev" },
      el("span", { class: "num seq", text: "#" + e.seq }),
      el("span", { class: "type" }, String(e.type).replace(/_/g, " "), run ? el("span", { class: "run", text: run }) : null),
      el("span", { class: "actor muted", text: e.actor }),
      el("span", { class: "kv" }, ...eventDetail(e.payload).map((p) => el("span", {}, el("i", { text: p.key + " " }), p.value))));
  }
  function addEvent(e) {
    events.push(e);
    const log = $("log");
    log.append(eventRow(e, true));
    if (log.childNodes.length > 500) log.firstChild.remove();
    $("logEmpty").hidden = true;
  }
  function clearLog() { $("log").replaceChildren(); events.length = 0; $("logEmpty").hidden = false; }

  const pill = (outcome) => el("span", { class: "pill " + outcomeTone(outcome), text: outcome || "unknown" });

  async function showRuns() {
    const box = $("runsBody");
    box.replaceChildren(el("p", { class: "muted", text: "Loading…" }));
    try {
      const runs = await api("/api/runs");
      box.replaceChildren();
      if (runs.length === 0) { box.append(empty("No saved runs yet", "A run appears here when it finishes.")); return; }
      const table = el("table", {}, el("tr", {}, el("th", { text: "Run" }), el("th", { text: "Job" }), el("th", { text: "Outcome" }), el("th", { class: "num", text: "Claude spend" })));
      for (const r of runs) {
        const open = () => showRun(r.file);
        table.append(el("tr", { class: "clickable", tabindex: "0", onclick: open, onkeydown: (ev) => { if (ev.key === "Enter") open(); } },
          el("td", { class: "strong", text: r.runId }), el("td", { text: r.job || "" }), el("td", {}, pill(r.outcome)),
          el("td", { class: "num", text: r.spentUsd == null ? "" : "$" + r.spentUsd.toFixed(4) })));
      }
      box.append(el("div", { class: "card" }, el("div", { class: "table-wrap" }, table)));
    } catch (e) { box.replaceChildren(el("div", { class: "card error", text: e.message })); }
  }

  async function showRun(file) {
    const box = $("runsBody");
    const r = await api("/api/runs/" + encodeURIComponent(file));
    const stats = [];
    const add = (label, value) => { if (value !== undefined && value !== null && value !== "") stats.push(el("div", { class: "kpi" }, el("span", { class: "label", text: label }), el("b", { text: String(value) }))); };
    add("Outcome", r.outcome); add("Seed", r.seed); add("Claude spend", typeof r.spentUsd === "number" ? "$" + r.spentUsd.toFixed(4) : null);
    if (r.bid) add("Bid", money(r.bid.priceUsd));
    if (r.account) { add("Job profit", money(r.account.profitUsd)); add("Days", r.account.actualDays + " of " + r.account.contractDays); }
    if (r.closeout) add("Cash profit", money(r.closeout.cashProfitUsd));
    const approvals = el("table", {}, el("tr", {}, el("th", { text: "#" }), el("th", { text: "Decision" }), el("th", { text: "Asked by" }), el("th", { class: "num", text: "Amount" }), el("th", { text: "Outcome" }), el("th", { text: "Reason" })));
    for (const a of r.approvals || []) {
      const part = a.items && a.approvedItems && a.approvedItems.length < a.items.length ? " (" + a.approvedItems.length + " of " + a.items.length + " items)" : "";
      const tone = a.status === "approved" ? "success" : a.status === "rejected" ? "danger" : "warning";
      approvals.append(el("tr", {}, el("td", { class: "num", text: String(a.id) }), el("td", { class: "strong", text: gateLabel(a.gate) }), el("td", { text: a.requestedBy }),
        el("td", { class: "num", text: money(a.amountUsd) }), el("td", {}, el("span", { class: "pill " + tone, text: a.status + (a.autoApproved ? " (auto)" : "") + part })), el("td", { text: a.reason || "" })));
    }
    const filter = el("input", { type: "text", placeholder: "Filter events by type or actor", "aria-label": "Filter events" });
    const log = el("div", { class: "events" });
    const renderLog = () => {
      const q = filter.value.trim().toLowerCase();
      log.replaceChildren(...(r.events || []).filter((e) => !q || e.type.includes(q) || e.actor.toLowerCase().includes(q)).map((e) => eventRow(e)));
    };
    filter.addEventListener("input", renderLog);
    renderLog();
    box.replaceChildren(
      el("div", {}, el("button", { class: "btn ghost", text: "← All runs", onclick: showRuns })),
      el("div", { class: "card" }, el("div", { class: "card-h" }, el("h2", { text: r.runId }), el("span", { class: "row" }, pill(r.outcome), el("a", { class: "link", href: routeHash({ view: "job", runId: r.runId }), text: "Open in workspace" }))), r.reason ? el("div", { class: "prose" }, el("p", { text: r.reason })) : null),
      stats.length ? el("div", { class: "kpis" }, ...stats) : null,
      el("div", { class: "card" }, el("h2", { text: "Approvals" }), el("div", { class: "table-wrap" }, approvals)),
      el("div", { class: "card" }, el("div", { class: "card-h" }, el("h2", { text: "Events" })), el("div", { class: "row" }, filter), log));
  }

  async function loadLaunch() {
    try {
      launch = await api("/api/launch");
      $("startTab").hidden = false;
      if (route.view === "settings" && route.tab === "start") show(); else renderStart();
    } catch { $("startTab").hidden = true; launch = null; }
  }

  function renderStart() {
    const box = $("startBody");
    if (!launch) { box.replaceChildren(); return; }
    const status = el("div", { class: "card" });
    const full = launch.running.length >= launch.maxParallel;
    if (launch.running.length) {
      status.append(el("div", { class: "card-h" }, el("h2", { text: "Running now" }), el("span", { class: "pill info", text: launch.running.length + " of " + launch.maxParallel })));
      for (const r of launch.running) {
        status.append(el("div", { class: "running" }, el("span", { class: "num", text: "#" + r.launchId + " " + r.argv.join(" ") }),
          el("span", { class: "muted small", text: "Started by " + r.startedBy + " at " + new Date(r.startedAt).toLocaleString() })));
      }
      status.append(el("p", { class: "muted small", text: "Decisions show up under Approvals, marked with their run. Events show up in the Live log." }));
    } else if (!launch.finished.length) status.append(el("div", { class: "empty" }, el("h3", { text: "No run started here yet" }), el("p", { text: "Finished runs are saved and listed under Past runs." })));
    const finished = launch.finished.map((l, i) => {
      const d = el("details", {}, el("summary", {}, el("span", { class: "num", text: "#" + l.launchId + " " + l.argv.join(" ") + " " }),
          el("span", { class: "pill " + (l.exitCode === 0 ? "success" : "danger"), text: l.exitCode === 0 ? "Finished" : "Exit code " + l.exitCode }),
          el("span", { class: "muted small", text: " " + new Date(l.finishedAt).toLocaleString() + ", started by " + l.startedBy })),
        el("div", { class: "output", text: l.output.join("\\n") }));
      if (i === 0) d.open = true;
      return d;
    });
    if (finished.length) status.append(el("h2", { text: "Finished here" }), ...finished);

    const command = el("select", { "aria-label": "What to run" }, ...["closeout", "job", "bid", "hiring"].map((c) => el("option", { value: c, text: c })));
    const job = el("select", { "aria-label": "Job" }, el("option", { value: "", text: "Job: picked by seed" }),
      ...launch.jobs.map((j) => el("option", { value: j.noticeId, text: j.noticeId + " · " + j.title + (j.complexity ? " (" + j.complexity + ")" : "") })));
    const seed = el("input", { type: "text", inputmode: "numeric", placeholder: "Seed (random if empty)", "aria-label": "Seed" });
    const force = el("input", { type: "checkbox" });
    const stub = el("input", { type: "checkbox" });
    const forceLabel = el("label", { class: "check" }, force, el("span", { text: "Force award if the bid loses on price (simulation only)" }));
    const auto = el("input", { type: "checkbox" });
    const autoLabel = el("label", { class: "check" }, auto, el("span", { text: "Approve every gate automatically (simulation only). A closeout run that closes this way counts toward promoting to prod." }));
    const sync = () => { job.disabled = command.value === "hiring"; forceLabel.hidden = !["job", "closeout"].includes(command.value); autoLabel.hidden = command.value === "hiring"; };
    command.addEventListener("change", sync);
    sync();
    const err = el("div", { class: "error", role: "alert" });
    const go = el("button", { class: "btn primary", type: "submit", text: "Start run" });
    go.disabled = full;
    const form = el("form", { class: "card" },
      el("div", { class: "prose" }, el("h2", { text: "New run" }),
        el("p", { class: "muted small", text: "Uses cloud models; each run has its own budget (RUN_BUDGET_USD). Up to " + launch.maxParallel + " runs at once (MAX_PARALLEL_RUNS)." })),
      el("div", { class: "row" }, command, job, seed),
      forceLabel,
      autoLabel,
      el("label", { class: "check" }, stub, el("span", { text: "Scripted models: no Claude cost, always bids STUB-E02, approves every gate" })),
      el("div", { class: "row" }, go, el("span", { class: "muted small", text: launchNote })), err);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      go.disabled = true; err.textContent = "";
      const body = { command: command.value, stub: stub.checked };
      if (!job.disabled && job.value) body.job = job.value;
      if (seed.value.trim()) body.seed = seed.value.trim();
      if (!forceLabel.hidden && force.checked) body.forceAward = true;
      if (!autoLabel.hidden && auto.checked) body.autoApprove = true;
      try {
        launch = { ...launch, ...(await api("/api/launch", { method: "POST", body: JSON.stringify(body) })) };
        launchNote = "Started.";
        renderStart();
      } catch (e) { err.textContent = e.message; go.disabled = launch.running.length >= launch.maxParallel; }
    });
    box.replaceChildren(status, form);
  }

  let es = null;
  const setConn = (text, live) => { const c = $("conn"); c.textContent = text; c.classList.toggle("live", !!live); c.hidden = !text; };
  function showLogin(message) {
    if (es) { es.close(); es = null; }
    csrf = "";
    document.body.classList.add("signed-out");
    signed = false;
    $("nav").hidden = true; $("settingsLink").hidden = true; $("logout").hidden = true; $("who").textContent = ""; setConn("");
    document.querySelectorAll("main > section[data-screen]").forEach((sec) => { sec.hidden = true; });
    $("startTab").hidden = true; launch = null; work = { jobs: [], stats: null };
    const err = el("div", { class: "error", role: "alert", text: message || "" });
    const field = (label, input) => el("label", { class: "field" }, el("span", { text: label }), input);
    const user = el("input", { type: "text", name: "username", autocomplete: "username", required: "" });
    const pass = el("input", { type: "password", name: "password", autocomplete: "current-password", required: "" });
    const code = el("input", { type: "text", name: "code", autocomplete: "one-time-code", inputmode: "numeric", pattern: "[0-9 ]{6,7}", required: "" });
    const go = el("button", { class: "btn primary", type: "submit", text: "Sign in" });
    const form = el("form", { class: "card login" }, el("div", { class: "wordmark" }, "Contracting", el("b", { text: ".Bid" })),
      el("div", { class: "prose" }, el("h1", { text: "Sign in" }), el("p", { class: "muted small", text: "Owner dashboard" })),
      err, field("Login name", user), field("Password", pass), field("6-digit code from your authenticator app", code), go);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      go.disabled = true; err.textContent = "";
      try {
        const me = await api("/api/login", { method: "POST", body: JSON.stringify({ username: user.value, password: pass.value, code: code.value }) });
        pass.value = ""; code.value = "";
        signedIn(me);
      } catch (e) { err.textContent = e.message; code.value = ""; }
      finally { go.disabled = false; }
    });
    $("login").replaceChildren(el("div", { class: "login-wrap" }, form));
    $("login").hidden = false;
    user.focus();
  }

  function signedIn(me) {
    csrf = me.csrf;
    document.body.classList.remove("signed-out");
    $("login").hidden = true; $("login").replaceChildren();
    signed = true;
    $("nav").hidden = false; $("settingsLink").hidden = false; $("logout").hidden = false; $("who").textContent = me.username;
    if (me.stack) {
      // Says which stack this is, so staging is never mistaken for prod.
      const badge = $("stackBadge");
      badge.textContent = me.stack === "prod" ? "Production" : me.stack === "staging" ? "Staging" : "Dev";
      badge.className = "pill " + (me.stack === "prod" ? "info" : "warning");
      badge.hidden = false;
    }
    show();
    connect();
  }

  $("logout").addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST", body: "{}" }); } catch {}
    showLogin("Signed out.");
  });

  async function connect() {
    clearLog();
    try {
      const state = await api("/api/state");
      pending = state.pending;
      state.events.forEach(addEvent);
      renderApprovals();
    } catch (e) { $("approvalsBody").replaceChildren(el("div", { class: "card error", text: e.message })); return; }
    es = new EventSource("/api/stream");
    es.addEventListener("open", () => setConn("Live", true));
    es.addEventListener("error", () => { setConn("Disconnected", false); api("/api/me").catch(() => {}); });
    es.addEventListener("approval", (m) => { const r = JSON.parse(m.data); pending = pending.filter((p) => p.id !== r.id).concat(r); renderApprovals(); });
    es.addEventListener("decided", (m) => { const d = JSON.parse(m.data); pending = pending.filter((p) => p.id !== d.id); renderApprovals(); });
    es.addEventListener("event", (m) => { addEvent(JSON.parse(m.data)); refreshWork(); });
    es.addEventListener("cleared", clearLog);
    es.addEventListener("launch", (m) => {
      if (!launch) return;
      launch = { ...launch, ...JSON.parse(m.data) };
      launchNote = "";
      if (!$("start").hidden) renderStart();
    });
    loadLaunch();
    loadWork();
  }
  fetch("/api/me", { credentials: "same-origin" })
    .then(async (res) => (res.ok ? signedIn(await res.json()) : showLogin()))
    .catch(() => showLogin("Cannot reach the dashboard."));
})();
</script>
</body>
</html>
`;
