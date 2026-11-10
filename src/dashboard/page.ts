/**
 * The dashboard page: one self-contained HTML file with inline CSS and JS.
 * Every value from a report or event is set with textContent, never as
 * HTML, because agents write much of that text.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Owner Dashboard</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#1c2430; --muted:#5f6b7a; --line:#dde2e8; --accent:#2457c5; --ok:#1d7a46; --bad:#b3261e; --warn:#8a5a00; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12161c; --card:#1b2129; --ink:#e7ebf0; --muted:#9aa6b4; --line:#2d3540; --accent:#7aa2ff; --ok:#5fc78c; --bad:#ff8a80; --warn:#f0c060; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  header { display:flex; gap:16px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); background:var(--card); position:sticky; top:0; }
  header h1 { font-size:17px; margin:0 12px 0 0; }
  nav button { background:none; border:0; padding:6px 10px; color:var(--muted); font:inherit; cursor:pointer; border-radius:6px; }
  nav button.on { color:var(--ink); background:var(--bg); font-weight:600; }
  .badge { display:inline-block; min-width:20px; padding:0 6px; border-radius:10px; background:var(--bad); color:#fff; font-size:12px; text-align:center; }
  main { max-width:980px; margin:0 auto; padding:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:12px; }
  .card h3 { margin:0 0 4px; font-size:15px; }
  .muted { color:var(--muted); }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:10px; }
  button.act { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--ink); cursor:pointer; }
  button.ok { background:var(--ok); border-color:var(--ok); color:#fff; }
  button.bad { color:var(--bad); }
  input[type=text] { font:inherit; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); flex:1; min-width:160px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .items label { display:flex; gap:8px; padding:4px 0; }
  .pill { display:inline-block; padding:1px 8px; border-radius:10px; font-size:12px; border:1px solid var(--line); }
  .pill.good { color:var(--ok); border-color:var(--ok); } .pill.badp { color:var(--bad); border-color:var(--bad); } .pill.mid { color:var(--warn); border-color:var(--warn); }
  .log { font:12px/1.5 ui-monospace, monospace; white-space:pre-wrap; word-break:break-word; }
  .error { color:var(--bad); }
  .clickable { cursor:pointer; } .clickable:hover { background:var(--bg); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:8px; }
  .stat { border:1px solid var(--line); border-radius:8px; padding:8px 10px; }
  .stat b { display:block; font-size:18px; }
</style>
</head>
<body>
<header>
  <h1>Owner Dashboard</h1>
  <nav>
    <button data-tab="approvals" class="on">Approvals <span id="count" class="badge" hidden>0</span></button>
    <button data-tab="live">Live log</button>
    <button data-tab="runs">Past runs</button>
  </nav>
  <span id="conn" class="muted" style="margin-left:auto"></span>
</header>
<main>
  <section id="approvals"></section>
  <section id="live" hidden><div class="card log" id="log"></div></section>
  <section id="runs" hidden></section>
</main>
<script>
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
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
  const money = (n) => typeof n === "number" ? "$" + n.toLocaleString("en-US") : "";
  const api = async (path, init = {}) => {
    const res = await fetch(path, { ...init, headers: { "x-dashboard-token": token, "content-type": "application/json", ...(init.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  };
  let pending = [];
  const events = [];

  document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x === b));
    for (const id of ["approvals", "live", "runs"]) $(id).hidden = id !== b.dataset.tab;
    if (b.dataset.tab === "runs") showRuns();
  }));

  function renderApprovals() {
    const box = $("approvals");
    box.replaceChildren();
    $("count").hidden = pending.length === 0;
    $("count").textContent = String(pending.length);
    if (pending.length === 0) {
      box.append(el("div", { class: "card muted", text: "Nothing waiting for you. Approvals from a running simulation appear here." }));
      return;
    }
    for (const r of pending) box.append(approvalCard(r));
  }

  function approvalCard(r) {
    const err = el("div", { class: "error" });
    const reason = el("input", { type: "text", placeholder: "Reason (optional; shown to the agent)" });
    const send = async (body) => {
      try {
        await api("/api/approvals/" + r.id, { method: "POST", body: JSON.stringify(body) });
        pending = pending.filter((p) => p.id !== r.id);
        renderApprovals();
      } catch (e) { err.textContent = e.message; }
    };
    const head = el("div", {},
      el("h3", { text: r.gate.replace(/_/g, " ") + (r.amountUsd !== undefined ? " · " + money(r.amountUsd) : "") }),
      el("div", { class: "muted", text: "#" + r.id + " from " + r.requestedBy }),
      el("p", { text: r.summary }));
    const card = el("div", { class: "card" }, head);
    if (r.items && r.items.length) {
      const list = el("div", { class: "items" });
      const boxes = r.items.map((i) => {
        const cb = el("input", { type: "checkbox" });
        cb.checked = true;
        cb.value = i.id;
        list.append(el("label", {}, cb, el("span", { text: i.id + ": " + i.label + (i.amountUsd !== undefined ? ", " + money(i.amountUsd) : "") })));
        return cb;
      });
      card.append(list, el("div", { class: "row" },
        el("button", { class: "act ok", text: "Approve all", onclick: () => send({ approve: true, reason: reason.value }) }),
        el("button", { class: "act", text: "Approve checked only", onclick: () => {
          const items = boxes.filter((b) => b.checked).map((b) => b.value);
          send(items.length ? { approve: true, items, reason: reason.value } : { approve: false, reason: reason.value || "No items approved" });
        } }),
        el("button", { class: "act bad", text: "Reject", onclick: () => send({ approve: false, reason: reason.value }) }),
        reason));
    } else {
      card.append(el("div", { class: "row" },
        el("button", { class: "act ok", text: "Approve", onclick: () => send({ approve: true, reason: reason.value }) }),
        el("button", { class: "act bad", text: "Reject", onclick: () => send({ approve: false, reason: reason.value }) }),
        reason));
    }
    card.append(err);
    return card;
  }

  function eventLine(e) {
    const p = e.payload || {};
    const short = Object.entries(p).filter(([, v]) => typeof v !== "object" || v === null).slice(0, 6)
      .map(([k, v]) => k + "=" + (typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "…" : v)).join(" ");
    return "#" + e.seq + " " + e.type + " · " + e.actor + (short ? " · " + short : "");
  }
  function addEvent(e) {
    events.push(e);
    const log = $("log");
    log.append(el("div", { text: eventLine(e) }));
    if (log.childNodes.length > 500) log.firstChild.remove();
  }

  const pill = (outcome) => {
    const good = ["closed", "completed", "awarded", "complete"], bad = ["incomplete", "lost"];
    return el("span", { class: "pill " + (good.includes(outcome) ? "good" : bad.includes(outcome) ? "badp" : "mid"), text: outcome || "unknown" });
  };

  async function showRuns() {
    const box = $("runs");
    box.replaceChildren(el("div", { class: "muted", text: "Loading…" }));
    try {
      const runs = await api("/api/runs");
      box.replaceChildren();
      if (runs.length === 0) { box.append(el("div", { class: "card muted", text: "No saved reports yet." })); return; }
      const table = el("table", {}, el("tr", {}, ...["Run", "Job", "Outcome", "Claude spend"].map((h) => el("th", { text: h }))));
      for (const r of runs) {
        table.append(el("tr", { class: "clickable", onclick: () => showRun(r.file) },
          el("td", { text: r.runId }), el("td", { text: r.job || "" }), el("td", {}, pill(r.outcome)),
          el("td", { class: "num", text: r.spentUsd == null ? "" : "$" + r.spentUsd.toFixed(4) })));
      }
      box.append(el("div", { class: "card" }, table));
    } catch (e) { box.replaceChildren(el("div", { class: "card error", text: e.message })); }
  }

  async function showRun(file) {
    const box = $("runs");
    const r = await api("/api/runs/" + encodeURIComponent(file));
    const stats = [];
    const add = (label, value) => { if (value !== undefined && value !== null && value !== "") stats.push(el("div", { class: "stat" }, el("span", { class: "muted", text: label }), el("b", { text: String(value) }))); };
    add("Outcome", r.outcome); add("Seed", r.seed); add("Claude spend", typeof r.spentUsd === "number" ? "$" + r.spentUsd.toFixed(4) : null);
    if (r.bid) add("Bid", money(r.bid.priceUsd));
    if (r.account) { add("Job profit", money(r.account.profitUsd)); add("Days", r.account.actualDays + " of " + r.account.contractDays); }
    if (r.closeout) add("Cash profit", money(r.closeout.cashProfitUsd));
    const approvals = el("table", {}, el("tr", {}, ...["#", "Gate", "From", "Amount", "Decision", "Reason"].map((h) => el("th", { text: h }))));
    for (const a of r.approvals || []) {
      const part = a.items && a.approvedItems && a.approvedItems.length < a.items.length ? " (" + a.approvedItems.length + " of " + a.items.length + " items)" : "";
      approvals.append(el("tr", {}, el("td", { text: String(a.id) }), el("td", { text: a.gate }), el("td", { text: a.requestedBy }),
        el("td", { class: "num", text: money(a.amountUsd) }), el("td", { text: a.status + (a.autoApproved ? " (auto)" : "") + part }), el("td", { text: a.reason || "" })));
    }
    const filter = el("input", { type: "text", placeholder: "Filter events by type or actor" });
    const log = el("div", { class: "log" });
    const renderLog = () => {
      const q = filter.value.trim().toLowerCase();
      log.replaceChildren(...(r.events || []).filter((e) => !q || e.type.includes(q) || e.actor.toLowerCase().includes(q)).map((e) => el("div", { text: eventLine(e) })));
    };
    filter.addEventListener("input", renderLog);
    renderLog();
    box.replaceChildren(
      el("div", { class: "row" }, el("button", { class: "act", text: "← All runs", onclick: showRuns })),
      el("div", { class: "card" }, el("h3", { text: r.runId }), el("p", { text: r.reason || "" }), el("div", { class: "grid" }, ...stats)),
      el("div", { class: "card" }, el("h3", { text: "Approvals" }), approvals),
      el("div", { class: "card" }, el("h3", { text: "Events" }), el("div", { class: "row" }, filter), log));
  }

  async function connect() {
    if (!token) { $("approvals").replaceChildren(el("div", { class: "card error", text: "Open the full link the terminal printed; it carries the dashboard token." })); return; }
    try {
      const state = await api("/api/state");
      pending = state.pending;
      state.events.forEach(addEvent);
      renderApprovals();
    } catch (e) { $("approvals").replaceChildren(el("div", { class: "card error", text: e.message })); return; }
    const es = new EventSource("/api/stream?token=" + encodeURIComponent(token));
    es.addEventListener("open", () => { $("conn").textContent = "Live"; });
    es.addEventListener("error", () => { $("conn").textContent = "Disconnected"; });
    es.addEventListener("approval", (m) => { const r = JSON.parse(m.data); pending = pending.filter((p) => p.id !== r.id).concat(r); renderApprovals(); });
    es.addEventListener("decided", (m) => { const d = JSON.parse(m.data); pending = pending.filter((p) => p.id !== d.id); renderApprovals(); });
    es.addEventListener("event", (m) => addEvent(JSON.parse(m.data)));
  }
  connect();
})();
</script>
</body>
</html>
`;
