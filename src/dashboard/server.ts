import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ApprovalRequest } from "../approvals/approvals.js";
import type { ApprovalDecision, Approver } from "../agents/hiringTools.js";
import { InMemoryEventLog, type EventInput, type EventLog, type LoggedEvent } from "../events/eventLog.js";
import { DASHBOARD_HTML } from "./page.js";
import { LoginLimiter, SessionStore, hashPassword, readCookie, verifyPassword, verifyTotp, type Session, type UserStore } from "./auth.js";

export interface DashboardOptions {
  /** Where run reports are saved (the sim's --out directory). */
  runsDir: string;
  /** Who may sign in. */
  users: UserStore;
  /** 0 picks a free port. */
  port?: number;
  /** Address to listen on. Anything but loopback needs `tls`. Default 127.0.0.1. */
  host?: string;
  /** Certificate and key (PEM) to serve HTTPS directly. */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /**
   * Set when a reverse proxy such as Caddy terminates HTTPS in front of the
   * dashboard on this machine. Cookies are then marked Secure, and the client
   * address is read from the last X-Forwarded-For entry.
   */
  behindProxy?: boolean;
  /** Clock, for tests. */
  now?: () => number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

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
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Body must be a JSON object";
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
 * The owner dashboard: a web page for answering approvals while a
 * simulation runs, watching its events live, and reading saved reports.
 *
 * Everyone signs in with a name, a password and an authenticator code.
 * Sessions live in an HttpOnly, SameSite=Strict cookie. Every POST also
 * needs the session's CSRF token in a header, which another site's page
 * cannot send. Failed logins lock the name and the address out for a while.
 */
export class DashboardServer {
  private server: Server | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly decided: Array<{ request: ApprovalRequest; decision: ApprovalDecision }> = [];
  private readonly streams = new Map<ServerResponse, string>();
  private readonly recent: LoggedEvent[] = [];
  private readonly now: () => number;
  readonly sessions: SessionStore;
  readonly limiter: LoginLimiter;
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly o: DashboardOptions) {
    this.now = o.now ?? Date.now;
    this.sessions = new SessionStore(this.now);
    this.limiter = new LoginLimiter(this.now);
  }

  private get secure(): boolean {
    return Boolean(this.o.tls || this.o.behindProxy);
  }

  private get cookieName(): string {
    // The __Host- prefix makes the browser refuse the cookie unless it is Secure, host-only and Path=/.
    return this.secure ? "__Host-cb_session" : "cb_session";
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

  /** Answers a pending approval as the signed-in user. Returns an error message, or null. */
  decide(id: number, body: unknown, by: string): string | null {
    const p = this.pending.get(id);
    if (!p) return `No pending approval ${id}`;
    const parsed = parseDecision(body, p.request);
    if (typeof parsed === "string") return parsed;
    const decision = { ...parsed, by };
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

  /**
   * Starts listening. Refuses to serve plain HTTP beyond this machine, and
   * refuses to start with nobody able to sign in. Returns the URL to open.
   */
  async start(): Promise<string> {
    const host = this.o.host ?? "127.0.0.1";
    if (!LOOPBACK.has(host) && !this.o.tls) {
      throw new Error(
        `The dashboard will not serve plain HTTP on ${host}. Set DASHBOARD_TLS_CERT and DASHBOARD_TLS_KEY, or keep it on 127.0.0.1 behind Caddy (see README).`,
      );
    }
    if ((await this.o.users.list()).length === 0) {
      throw new Error("No dashboard logins exist yet. Create one with: pnpm sim user add <name>");
    }
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      this.route(req, res).catch(() => {
        if (!res.headersSent) this.send(res, 500, { error: "Internal error" });
        else res.end();
      });
    };
    const server = this.o.tls ? createHttpsServer({ cert: this.o.tls.cert, key: this.o.tls.key, minVersion: "TLSv1.2" }, handler) : createHttpServer(handler);
    server.headersTimeout = 20_000;
    server.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.o.port ?? 4100, host, () => resolve());
    });
    this.server = server;
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : this.o.port;
    const shown = host.includes(":") ? `[${host}]` : host;
    return `${this.o.tls ? "https" : "http"}://${shown}:${port}/`;
  }

  async stop(): Promise<void> {
    for (const s of this.streams.keys()) s.end();
    this.streams.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private broadcast(type: string, data: unknown): void {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [s, sessionId] of this.streams) {
      if (this.sessions.touch(sessionId)) s.write(frame);
      else {
        s.end();
        this.streams.delete(s);
      }
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      ...(this.secure ? { "strict-transport-security": "max-age=31536000" } : {}),
      ...extra,
    };
  }

  private send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    res.writeHead(status, this.headers({ "content-type": "application/json; charset=utf-8", ...extra }));
    res.end(JSON.stringify(body));
  }

  private sessionCookie(value: string, maxAgeS: number): string {
    return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${this.secure ? "; Secure" : ""}`;
  }

  private clientAddress(req: IncomingMessage): string {
    if (this.o.behindProxy) {
      const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (fwd.length) return fwd[fwd.length - 1]!;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  private session(req: IncomingMessage): Session | null {
    return this.sessions.touch(readCookie(req.headers.cookie, this.cookieName));
  }

  /** A POST must come from the dashboard's own page: same origin, with the custom header. */
  private sameOriginPost(req: IncomingMessage): boolean {
    if (req.headers["x-requested-with"] !== "dashboard") return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req, 4 * 1024)) as Record<string, unknown>;
    } catch {
      return this.send(res, 400, { error: "Body must be JSON" });
    }
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const code = typeof body.code === "string" ? body.code.replace(/\s/g, "") : "";
    const keys = [`ip:${this.clientAddress(req)}`, `user:${username}`];
    const wait = this.limiter.lockedFor(...keys);
    if (wait > 0) {
      return this.send(res, 429, { error: `Too many failed logins. Try again in ${Math.ceil(wait / 60_000)} minutes.` }, { "retry-after": String(Math.ceil(wait / 1000)) });
    }
    const user = username ? await this.o.users.get(username) : null;
    // Check a password even for an unknown name, so the response time does not reveal which names exist.
    const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await (this.dummyHash ??= hashPassword("not a real password"))));
    const step = user && passwordOk ? verifyTotp(user.totpSecret, code, this.now(), user.lastTotpStep) : null;
    if (!user || step === null) {
      this.limiter.fail(...keys);
      return this.send(res, 401, { error: "Wrong name, password or authenticator code" });
    }
    this.limiter.succeed(...keys);
    await this.o.users.put({ ...user, lastTotpStep: step });
    const s = this.sessions.create(user.username);
    this.send(res, 200, { username: s.username, csrf: s.csrf }, { "set-cookie": this.sessionCookie(s.id, 12 * 60 * 60) });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://dashboard");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, this.headers({
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      }));
      res.end(DASHBOARD_HTML);
      return;
    }
    if (!url.pathname.startsWith("/api/")) return this.send(res, 404, { error: "Not found" });
    if (req.method === "POST" && !this.sameOriginPost(req)) return this.send(res, 403, { error: "Requests must come from the dashboard page" });
    if (req.method === "POST" && url.pathname === "/api/login") return this.login(req, res);

    const session = this.session(req);
    if (!session) return this.send(res, 401, { error: "Sign in first" });
    if (req.method === "POST" && !csrfMatches(req.headers["x-csrf-token"], session.csrf)) return this.send(res, 403, { error: "Missing or wrong CSRF token" });

    if (req.method === "GET" && url.pathname === "/api/me") return this.send(res, 200, { username: session.username, csrf: session.csrf });
    if (req.method === "POST" && url.pathname === "/api/logout") {
      this.sessions.end(session.id);
      return this.send(res, 200, { ok: true }, { "set-cookie": this.sessionCookie("", 0) });
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return this.send(res, 200, { pending: this.pendingRequests(), decided: this.decided, events: this.recent });
    }
    if (req.method === "GET" && url.pathname === "/api/runs") return this.send(res, 200, await this.listRuns());
    const run = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && run) {
      let file: string;
      try {
        file = decodeURIComponent(run[1]!);
      } catch {
        return this.send(res, 404, { error: "No such report" });
      }
      const report = await this.readRun(file);
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
      const problem = this.decide(Number(approval[1]), body, session.username);
      return problem ? this.send(res, problem.startsWith("No pending") ? 404 : 400, { error: problem }) : this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, this.headers({ "content-type": "text/event-stream", connection: "keep-alive" }));
      res.write(": connected\n\n");
      this.streams.set(res, session.id);
      req.on("close", () => this.streams.delete(res));
      return;
    }
    return this.send(res, 404, { error: "Not found" });
  }
}

function csrfMatches(given: string | string[] | undefined, want: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
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
