/**
 * The three stacks the app runs as. Each has its own database:
 *  - dev: the working copy on the owner's machine, sim data.
 *  - staging: a committed build under test, sim data.
 *  - prod: a build that passed staging; no sim runs and no sim data, ever.
 */
export const STACKS = ["dev", "staging", "prod"] as const;
export type Stack = (typeof STACKS)[number];

export function isStack(value: string): value is Stack {
  return (STACKS as readonly string[]).includes(value);
}

/** The stack this process runs as: APP_STACK, or dev when it is not set. Throws on anything else. */
export function stackFromEnv(env: Record<string, string | undefined> = process.env): Stack {
  const raw = (env.APP_STACK ?? "").trim().toLowerCase();
  if (raw === "") return "dev";
  if (!isStack(raw)) throw new Error(`APP_STACK must be one of ${STACKS.join(", ")}, not "${env.APP_STACK}"`);
  return raw;
}

/** The sim commands that start a simulated run and write sim data. */
export const SIM_RUN_COMMANDS = ["hiring", "bench", "bid", "job", "closeout"] as const;

/** Whether a stack may start simulated runs. Prod never does. */
export function allowsSimRuns(stack: Stack): boolean {
  return stack !== "prod";
}

/** Why `command` may not run on `stack`, or null when it may. */
export function simRefusal(stack: Stack, command: string | undefined): string | null {
  if (allowsSimRuns(stack) || !(SIM_RUN_COMMANDS as readonly string[]).includes(command ?? "")) return null;
  return `The ${stack} stack never runs simulations, so its database holds only real data. Run "${command}" on dev or staging.`;
}

/** The exit code a CLI returns when the stack refuses a command. */
export const REFUSED_ON_STACK = 3;
