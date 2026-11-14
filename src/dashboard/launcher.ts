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

export interface RunningLaunch {
  /** Numbers the runs started by this service, from 1. */
  launchId: number;
  command: LaunchCommand;
  argv: string[];
  startedBy: string;
  startedAt: string;
}

export interface FinishedLaunch extends RunningLaunch {
  exitCode: number;
  finishedAt: string;
  output: string[];
}

export interface LaunchState {
  running: RunningLaunch[];
  /** The latest finished runs, newest first. */
  finished: FinishedLaunch[];
  maxParallel: number;
}

/** The longest seed the sim accepts (the seeds it picks itself are below 2^32). */
const MAX_SEED = 2 ** 32 - 1;
/** Lines of a run's output kept for the page. */
export const OUTPUT_LINES = 60;
/** Finished runs kept for the page. */
export const FINISHED_KEPT = 10;
/** Runs that may go at once unless MAX_PARALLEL_RUNS says otherwise. */
export const DEFAULT_MAX_PARALLEL = 3;

/** MAX_PARALLEL_RUNS as a number of runs, or the default. Throws on a bad value. */
export function maxParallelRuns(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MAX_PARALLEL;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error(`MAX_PARALLEL_RUNS must be a whole number from 1 to 20, not "${value}"`);
  return n;
}

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

/** Runs one `pnpm sim` command line for `by`, writing its output with `out`. Returns the exit code. */
export type RunFn = (argv: string[], out: (line: string) => void, by: string) => Promise<number>;

/** Runs requests from the page side by side, up to a limit. */
export class RunLauncher {
  private readonly running = new Map<number, RunningLaunch>();
  private readonly finished: FinishedLaunch[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private nextId = 1;
  /** Called whenever a run starts or ends. */
  onChange: (state: LaunchState) => void = () => undefined;

  constructor(
    private readonly run: RunFn,
    readonly jobs: readonly LaunchJob[],
    private readonly now: () => Date = () => new Date(),
    readonly maxParallel = DEFAULT_MAX_PARALLEL,
  ) {}

  state(): LaunchState {
    return {
      running: [...this.running.values()].map((r) => ({ ...r, argv: [...r.argv] })),
      finished: this.finished.map((f) => ({ ...f, argv: [...f.argv], output: [...f.output] })),
      maxParallel: this.maxParallel,
    };
  }

  /** True when no more runs may start until one ends. */
  full(): boolean {
    return this.running.size >= this.maxParallel;
  }

  /** Starts a run in the background for `by`. Returns an error message, or null when it started. */
  start(body: unknown, by: string): string | null {
    if (this.full()) return `${this.running.size} run(s) are already going, the most at once (MAX_PARALLEL_RUNS). Wait for one to finish.`;
    const req = parseLaunch(body, this.jobs.map((j) => j.noticeId));
    if (typeof req === "string") return req;
    const argv = launchArgv(req);
    const entry: RunningLaunch = { launchId: this.nextId++, command: req.command, argv, startedBy: by, startedAt: this.now().toISOString() };
    this.running.set(entry.launchId, entry);
    const output: string[] = [];
    const out = (line: string) => {
      output.push(line);
      if (output.length > OUTPUT_LINES) output.shift();
    };
    const done = (async () => {
      let exitCode: number;
      try {
        exitCode = await this.run(argv, out, by);
      } catch (err) {
        out(err instanceof Error ? err.message : String(err));
        exitCode = 1;
      }
      this.running.delete(entry.launchId);
      this.finished.unshift({ ...entry, exitCode, finishedAt: this.now().toISOString(), output });
      if (this.finished.length > FINISHED_KEPT) this.finished.pop();
      this.onChange(this.state());
    })();
    this.inFlight.add(done);
    void done.finally(() => this.inFlight.delete(done));
    this.onChange(this.state());
    return null;
  }

  /** Resolves when every run going now has finished. */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }
}
