/**
 * The dashboard page: one self-contained HTML file with inline CSS and JS,
 * in the Blueprint design the customer site uses (web/src/design). The colour
 * values are copied from that design's tokens; a test fails if they drift.
 *
 * Every value from a report or event is set with textContent, never as
 * HTML, because agents write much of that text.
 */

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
  nav button { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; background:none; border:0; padding:8px 12px; color:inherit; font:500 14px/24px var(--font-sans); text-align:left; cursor:pointer; border-radius:var(--r); }
  nav button:hover { background:var(--shell-raised); color:var(--on-shell); }
  nav button.on { background:var(--shell-raised); color:var(--on-shell); box-shadow:inset 3px 0 0 var(--accent); }
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
  .card { background:var(--surface); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow-card); padding:24px; min-width:0; display:grid; gap:16px; }
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
  .btn.primary { background:var(--brand); border-color:var(--brand); color:var(--on-brand); }
  .btn.primary:hover { filter:brightness(0.94); }
  .btn.ghost { border-color:transparent; background:none; color:var(--brand-ink); padding-left:0; }
  .btn.reject { color:var(--danger); border-color:var(--danger); }
  .btn:disabled { opacity:0.5; cursor:not-allowed; }
  .btn:focus-visible, input:focus-visible, select:focus-visible, nav button:focus-visible, .clickable:focus-visible, summary:focus-visible { outline:2px solid var(--brand); outline-offset:2px; }
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

  @media (max-width:820px) {
    .shell { grid-template-columns:minmax(0, 1fr); }
    .side { position:static; height:auto; padding:16px; gap:12px; }
    nav { flex-direction:row; overflow-x:auto; }
    nav button { width:auto; white-space:nowrap; }
    .side-foot { margin-top:0; grid-auto-flow:column; justify-content:start; align-items:center; gap:16px; padding:12px 12px 0; }
    main { padding:16px; }
    .card { padding:16px; }
    .ev { grid-template-columns:44px minmax(0, 1fr); }
    .ev .actor, .ev .kv { grid-column:2; }
    .approval-top .amount { margin-left:0; width:100%; }
  }
</style>
</head>
<body class="signed-out">
<div class="shell">
  <aside class="side">
    <div>
      <div class="wordmark">Contracting<b>.Bid</b></div>
      <div class="side-label">Owner dashboard</div>
    </div>
    <nav id="nav" aria-label="Dashboard" hidden>
      <button data-tab="approvals" class="on"><span>Approvals</span><span id="count" class="badge" hidden>0</span></button>
      <button data-tab="live"><span>Live log</span></button>
      <button data-tab="runs"><span>Past runs</span></button>
      <button data-tab="start" id="startTab" hidden><span>Start a run</span></button>
    </nav>
    <div class="side-foot">
      <span id="conn" class="conn"></span>
      <span id="who"></span>
      <button id="logout" hidden>Sign out</button>
    </div>
  </aside>
  <main>
    <section id="login" hidden></section>
    <section id="approvals" hidden>
      <div class="pagehead"><h1>Approvals</h1></div>
      <div id="approvalsBody" class="stack"></div>
    </section>
    <section id="live" hidden>
      <div class="pagehead"><h1>Live log</h1></div>
      <div class="card"><div id="log" class="events"></div><div id="logEmpty" class="empty"><h3>Nothing yet</h3><p>Events from a running simulation appear here as they happen.</p></div></div>
    </section>
    <section id="runs" hidden>
      <div class="pagehead"><h1>Past runs</h1></div>
      <div id="runsBody" class="stack"></div>
    </section>
    <section id="start" hidden>
      <div class="pagehead"><h1>Start a run</h1></div>
      <div id="startBody" class="stack"></div>
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

  document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((x) => { x.classList.toggle("on", x === b); if (x === b) x.setAttribute("aria-current", "page"); else x.removeAttribute("aria-current"); });
    for (const id of TABS) $(id).hidden = id !== b.dataset.tab;
    if (b.dataset.tab === "runs") showRuns();
    if (b.dataset.tab === "start") renderStart();
  }));

  function renderApprovals() {
    const box = $("approvalsBody");
    box.replaceChildren();
    $("count").hidden = pending.length === 0;
    $("count").textContent = String(pending.length);
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
      el("div", { class: "card" }, el("div", { class: "card-h" }, el("h2", { text: r.runId }), pill(r.outcome)), r.reason ? el("div", { class: "prose" }, el("p", { text: r.reason })) : null),
      stats.length ? el("div", { class: "kpis" }, ...stats) : null,
      el("div", { class: "card" }, el("h2", { text: "Approvals" }), el("div", { class: "table-wrap" }, approvals)),
      el("div", { class: "card" }, el("div", { class: "card-h" }, el("h2", { text: "Events" })), el("div", { class: "row" }, filter), log));
  }

  async function loadLaunch() {
    try {
      launch = await api("/api/launch");
      $("startTab").hidden = false;
      renderStart();
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
    const sync = () => { job.disabled = command.value === "hiring"; forceLabel.hidden = !["job", "closeout"].includes(command.value); };
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
      el("label", { class: "check" }, stub, el("span", { text: "Scripted models: no Claude cost, always bids STUB-E02, approves every gate" })),
      el("div", { class: "row" }, go, el("span", { class: "muted small", text: launchNote })), err);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      go.disabled = true; err.textContent = "";
      const body = { command: command.value, stub: stub.checked };
      if (!job.disabled && job.value) body.job = job.value;
      if (seed.value.trim()) body.seed = seed.value.trim();
      if (!forceLabel.hidden && force.checked) body.forceAward = true;
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
    $("nav").hidden = true; $("logout").hidden = true; $("who").textContent = ""; setConn("");
    for (const id of TABS) $(id).hidden = true;
    $("startTab").hidden = true; launch = null;
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
    $("nav").hidden = false; $("logout").hidden = false; $("who").textContent = me.username;
    document.querySelectorAll("nav button").forEach((x) => { const on = x.dataset.tab === "approvals"; x.classList.toggle("on", on); if (on) x.setAttribute("aria-current", "page"); else x.removeAttribute("aria-current"); });
    $("approvals").hidden = false;
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
    es.addEventListener("event", (m) => addEvent(JSON.parse(m.data)));
    es.addEventListener("cleared", clearLog);
    es.addEventListener("launch", (m) => {
      if (!launch) return;
      launch = { ...launch, ...JSON.parse(m.data) };
      launchNote = "";
      if (!$("start").hidden) renderStart();
    });
    loadLaunch();
  }
  fetch("/api/me", { credentials: "same-origin" })
    .then(async (res) => (res.ok ? signedIn(await res.json()) : showLogin()))
    .catch(() => showLogin("Cannot reach the dashboard."));
})();
</script>
</body>
</html>
`;
