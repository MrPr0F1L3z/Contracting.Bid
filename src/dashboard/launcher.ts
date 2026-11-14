/**
 * Starts simulation runs from the dashboard, one at a time, for the
 * always-on service (`pnpm sim serve`). A run's approvals and events go to
 * the same dashboard, and the run is saved to the database as usual.
 */

export const LAUNCH_COMMANDS = ["hiring", "bid", "job", "closeout"] as const;
export type LaunchCommand = (typeof LAUNCH_COMMANDS)[number];

export interface LaunchRequest {
  command: LaunchCommand;
  /** A solicitation's notice ID; left out, the seed picks one. */
  job?: string;
  seed?: number;
  /** job and closeout: award a responsive bid even if it loses on price. */
  forceAward?: boolean;
  /** Scripted models: no API key and no cost. */
  stub?: boolean;
}

export interface LaunchJob {
  noticeId: string;
  title: string;
  complexity: string | null;
}

export interface LaunchState {
  running: { command: LaunchCommand; argv: string[]; startedBy: string; startedAt: string } | null;
  last: { command: LaunchCommand; argv: string[]; startedBy: string; exitCode: number; finishedAt: string; output: string[] } | null;
}

/** The longest seed the sim accepts (the seeds it picks itself are below 2^32). */
const MAX_SEED = 2 ** 32 - 1;
/** Lines of a run's output kept for the page. */
export const OUTPUT_LINES = 60;

/** Validates a run request posted by the page. Returns an error message or the request. */
export function parseLaunch(body: unknown, jobs: readonly string[]): LaunchRequest | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Body must be a JSON object";
  const { command, job, seed, forceAward, stub } = body as Record<string, unknown>;
  if (typeof command !== "string" || !(LAUNCH_COMMANDS as readonly string[]).includes(command)) return `command must be one of ${LAUNCH_COMMANDS.join(", ")}`;
  const c = command as LaunchCommand;
  const req: LaunchRequest = { command: c };
  if (job !== undefined && job !== null && job !== "") {
    if (c === "hiring") return "A hiring run has no job";
    if (typeof job !== "string" || !jobs.includes(job)) return "Unknown job";
    req.job = job;
  }
  if (seed !== undefined && seed !== null && seed !== "") {
    const n = typeof seed === "string" ? Number(seed) : seed;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_SEED) return "seed must be a whole number from 0 to 4294967295";
    req.seed = n;
  }
  if (forceAward !== undefined && forceAward !== false) {
    if (forceAward !== true) return "forceAward must be true or false";
    if (c !== "job" && c !== "closeout") return "Force award is only for job and closeout runs";
    req.forceAward = true;
  }
  if (stub !== undefined && stub !== false) {
    if (stub !== true) return "stub must be true or false";
    req.stub = true;
  }
  return req;
}

/** The `pnpm sim` arguments for a request. */
export function launchArgv(req: LaunchRequest): string[] {
  const argv: string[] = [req.command];
  if (req.job) argv.push("--job", req.job);
  if (req.seed !== undefined) argv.push("--seed", String(req.seed));
  if (req.forceAward) argv.push("--force-award");
  if (req.stub) argv.push("--stub");
  return argv;
}

export type RunFn = (argv: string[], out: (line: string) => void) => Promise<number>;

export class RunLauncher {
  private current: LaunchState["running"] = null;
  private previous: LaunchState["last"] = null;
  private done: Promise<void> = Promise.resolve();
  /** Called whenever a run starts or ends. */
  onChange: (state: LaunchState) => void = () => undefined;

  constructor(
    private readonly run: RunFn,
    readonly jobs: readonly LaunchJob[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  state(): LaunchState {
    return {
      running: this.current && { ...this.current, argv: [...this.current.argv] },
      last: this.previous && { ...this.previous, argv: [...this.previous.argv], output: [...this.previous.output] },
    };
  }

  /** Starts a run in the background for `by`. Returns an error message, or null when it started. */
  start(body: unknown, by: string): string | null {
    if (this.current) return `A ${this.current.command} run is already going. Wait for it to finish.`;
    const req = parseLaunch(body, this.jobs.map((j) => j.noticeId));
    if (typeof req === "string") return req;
    const argv = launchArgv(req);
    const running = { command: req.command, argv, startedBy: by, startedAt: this.now().toISOString() };
    this.current = running;
    const output: string[] = [];
    const out = (line: string) => {
      output.push(line);
      if (output.length > OUTPUT_LINES) output.shift();
    };
    this.done = (async () => {
      let exitCode: number;
      try {
        exitCode = await this.run(argv, out);
      } catch (err) {
        out(err instanceof Error ? err.message : String(err));
        exitCode = 1;
      }
      this.current = null;
      this.previous = { ...running, exitCode, finishedAt: this.now().toISOString(), output };
      this.onChange(this.state());
    })();
    this.onChange(this.state());
    return null;
  }

  /** Resolves when the current run (if any) has finished. */
  idle(): Promise<void> {
    return this.done;
  }
}
