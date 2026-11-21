import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Stack } from "../config/stack.js";

/** One check in a deploy, as the ledger and the failure report keep it. */
export interface StepResult {
  name: string;
  ok: boolean;
  /** The command's output or the reason it failed, cut to the last lines. */
  detail?: string;
}

/** One deploy of a build to a stack. */
export interface Deployment {
  stack: Stack;
  /** The commit, as the 12-character hash the image is tagged with. */
  build: string;
  at: string;
  result: "pass" | "fail";
  steps: StepResult[];
  /** For prod: the build it replaced, and whether a failed deploy went back to it. */
  previous?: string | null;
  rolledBack?: boolean;
  /** The build the stack runs after this deploy (prod), when it differs from what a deploy would suggest. */
  runningAfter?: string | null;
  /** Where the prod database was saved before the deploy. */
  backup?: string;
  /** The failure report for this deploy. */
  report?: string;
}

/** The deploy history in a JSON file, oldest first. It records; it never deploys. */
export class Ledger {
  constructor(readonly path: string) {}

  async all(): Promise<Deployment[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { deployments?: Deployment[] };
      return Array.isArray(parsed.deployments) ? parsed.deployments : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`Cannot read the deploy ledger ${this.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async add(d: Deployment): Promise<void> {
    const all = [...(await this.all()), d];
    await mkdir(dirname(this.path), { recursive: true });
    // Write a new file and swap it in, so a crash never leaves half a ledger.
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ deployments: all }, null, 2));
    await rename(tmp, this.path);
  }

  /** The newest deploy to a stack, passed or not. */
  async latest(stack: Stack): Promise<Deployment | null> {
    return (await this.all()).filter((d) => d.stack === stack).at(-1) ?? null;
  }

  /** The build a stack runs now: its newest passing deploy, or the build a failed prod deploy left running. */
  async running(stack: Stack): Promise<string | null> {
    const mine = (await this.all()).filter((d) => d.stack === stack);
    const last = mine.at(-1);
    if (!last) return null;
    if (last.runningAfter !== undefined) return last.runningAfter;
    if (last.result === "pass" || stack !== "prod") return last.build;
    return last.rolledBack ? (last.previous ?? null) : last.build;
  }

  /** Whether a build passed on a stack at least once. */
  async passed(stack: Stack, build: string): Promise<boolean> {
    return (await this.all()).some((d) => d.stack === stack && d.build === build && d.result === "pass");
  }

  /** The newest build that passed on a stack. */
  async latestPass(stack: Stack): Promise<string | null> {
    return (await this.all()).filter((d) => d.stack === stack && d.result === "pass").at(-1)?.build ?? null;
  }
}
