import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ApprovalRequest } from "../approvals/approvals.js";
import type { ApprovalDecision, Approver } from "../agents/hiringTools.js";
import { InMemoryEventLog, type EventInput, type EventLog, type LoggedEvent } from "../events/eventLog.js";
import { DASHBOARD_HTML } from "./page.js";

export interface DashboardOptions {
  /** Where run reports are saved (the sim's --out directory). */
  runsDir: string;
  /** 0 picks a free port. */
  port?: number;
  /** Fixed token for tests; random otherwise. */
  token?: string;
}

/** A summary of one saved report, for the run list. */
export interface RunSummary {
  file: string;
  runId: string;
  seed: number | null;
  outcome: string | null;
  reason: string | null;
  job: string | null;
  spentUsd: number | null;
}

interface Pending {
  request: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
}

const REPORT_FILE = /^[\w.-]+\.json$/;

/** Validates a decision posted by the page. Returns an error message or the decision. */
export function parseDecision(body: unknown, request: ApprovalRequest): ApprovalDecision | string {
  if (typeof body !== "object" || body === null) return "Body must be a JSON object";
  const { approve, reason, items } = body as Record<string, unknown>;
  if (typeof approve !== "boolean") return "approve must be true or false";
  if (reason !== undefined && typeof reason !== "string") return "reason must be text";
  if (items !== undefined) {
    if (!request.items) return "This approval has no items";
    if (!Array.isArray(items) || !items.every((i) => typeof i === "string")) return "items must be a list of item ids";
    const unknown = items.find((i) => !request.items!.some((x) => x.id === i));
    if (unknown !== undefined) return `Unknown item ${String(unknown)}`;
  }
  return {
    approve,
    ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {}),
    ...(Array.isArray(items) ? { items: items as string[] } : {}),
  };
}

/** Reads the summary fields of a report, tolerating any report shape. */
export function summarize(file: string, report: Record<string, unknown>): RunSummary {
  const opp = report.opportunity as { noticeId?: string } | null | undefined;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    file,
    runId: str(report.runId) ?? file.replace(/\.json$/, ""),
    seed: num(report.seed),
    outcome: str(report.outcome),
    reason: str(report.reason),
    job: opp?.noticeId ?? null,
    spentUsd: num(report.spentUsd),
  };
}

/**
 * The owner dashboard: a local web page for answering approvals while a
 * simulation runs, watching its events live, and reading saved reports.
 * It listens on 127.0.0.1 only. Every API call must carry the token from
 * the printed URL in an x-dashboard-token header, which another site's page
 * cannot send, so a web page you visit cannot approve anything.
 */
export class DashboardServer {
  readonly token: string;
  private server: Server | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly decided: Array<{ request: ApprovalRequest; decision: ApprovalDecision }> = [];
  private readonly streams = new Set<ServerResponse>();
  private readonly recent: LoggedEvent[] = [];

  constructor(private readonly o: DashboardOptions) {
    this.token = o.token ?? randomBytes(16).toString("hex");
  }

  /** An approver that waits for the owner to decide on the page. */
  approver(): Approver {
    return (request) =>
      new Promise<ApprovalDecision>((resolve) => {
        this.pending.set(request.id, { request: { ...request }, resolve });
        this.broadcast("approval", { ...request });
      });
  }

  /** Wraps an event log so every event is also streamed to the page. */
  tee(log: EventLog = new InMemoryEventLog()): EventLog {
    return {
      append: (event: EventInput) => {
        const logged = log.append(event);
        this.recent.push(logged);
        if (this.recent.length > 500) this.recent.shift();
        this.broadcast("event", logged);
        return logged;
      },
      list: (filter) => log.list(filter),
    };
  }

  pendingRequests(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => ({ ...p.request }));
  }

  /** Answers a pending approval. Returns an error message, or null. */
  decide(id: number, body: unknown): string | null {
    const p = this.pending.get(id);
    if (!p) return `No pending approval ${id}`;
    const decision = parseDecision(body, p.request);
    if (typeof decision === "string") return decision;
    this.pending.delete(id);
    this.decided.push({ request: p.request, decision });
    this.broadcast("decided", { id, ...decision });
    p.resolve(decision);
    return null;
  }

  async listRuns(): Promise<RunSummary[]> {
    let files: string[];
    try {
      files = (await readdir(this.o.runsDir)).filter((f) => REPORT_FILE.test(f));
    } catch {
      return [];
    }
    const out: RunSummary[] = [];
    for (const f of files.sort().reverse()) {
      try {
        out.push(summarize(f, JSON.parse(await readFile(join(this.o.runsDir, f), "utf8")) as Record<string, unknown>));
      } catch {
        out.push(summarize(f, {}));
      }
    }
    return out;
  }

  async readRun(file: string): Promise<unknown | null> {
    if (!REPORT_FILE.test(file) || basename(file) !== file) return null;
    try {
      return JSON.parse(await readFile(join(this.o.runsDir, file), "utf8"));
    } catch {
      return null;
    }
  }

  /** Starts listening on 127.0.0.1. Returns the URL to open, token included. */
  async start(): Promise<string> {
    const server = createServer((req, res) => {
      this.route(req, res).catch(() => this.send(res, 500, { error: "Internal error" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.o.port ?? 4100, "127.0.0.1", () => resolve());
    });
    this.server = server;
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : this.o.port;
    return `http://127.0.0.1:${port}/#token=${this.token}`;
  }

  async stop(): Promise<void> {
    for (const s of this.streams) s.end();
    this.streams.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private broadcast(type: string, data: unknown): void {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of this.streams) s.write(frame);
  }

  private send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
    res.writeHead(status, {
      "content-type": type === "application/json" ? "application/json; charset=utf-8" : type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(type.startsWith("text/html") ? { "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" } : {}),
    });
    res.end(type === "application/json" ? JSON.stringify(body) : String(body));
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    // EventSource cannot set headers, so the live stream takes the token as a query parameter.
    const given = req.headers["x-dashboard-token"] ?? (url.pathname === "/api/stream" ? url.searchParams.get("token") : null);
    return given === this.token;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") return this.send(res, 200, DASHBOARD_HTML, "text/html; charset=utf-8");
    if (!url.pathname.startsWith("/api/")) return this.send(res, 404, { error: "Not found" });
    if (!this.authorized(req, url)) return this.send(res, 401, { error: "Missing or wrong dashboard token" });

    if (req.method === "GET" && url.pathname === "/api/state") {
      return this.send(res, 200, { pending: this.pendingRequests(), decided: this.decided, events: this.recent });
    }
    if (req.method === "GET" && url.pathname === "/api/runs") return this.send(res, 200, await this.listRuns());
    const run = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && run) {
      const report = await this.readRun(decodeURIComponent(run[1]!));
      return report === null ? this.send(res, 404, { error: "No such report" }) : this.send(res, 200, report);
    }
    const approval = /^\/api\/approvals\/(\d+)$/.exec(url.pathname);
    if (req.method === "POST" && approval) {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return this.send(res, 400, { error: e instanceof Error && e.message === "too large" ? "Body too large" : "Body must be JSON" });
      }
      const problem = this.decide(Number(approval[1]), body);
      return problem ? this.send(res, problem.startsWith("No pending") ? 404 : 400, { error: problem }) : this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      this.streams.add(res);
      req.on("close", () => this.streams.delete(res));
      return;
    }
    return this.send(res, 404, { error: "Not found" });
  }
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
