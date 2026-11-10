import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { GpuHook } from "../config/config.js";

export type CommandRunner = (command: string) => Promise<void>;

const execAsync = promisify(exec);
export const shellRunner: CommandRunner = async (command) => {
  await execAsync(command);
};

/**
 * Pauses the owner's listed GPU processes, runs `task`, then resumes them,
 * even if the task or a later pause fails. Only commands the owner lists in
 * GPU_PAUSE_HOOKS are run; nothing is killed or uninstalled.
 */
export async function withGpuPaused<T>(
  hooks: GpuHook[],
  task: () => Promise<T>,
  run: CommandRunner = shellRunner,
  log: (msg: string) => void = () => {},
): Promise<T> {
  const paused: GpuHook[] = [];
  try {
    for (const hook of hooks) {
      log(`Pausing: ${hook.pause}`);
      await run(hook.pause);
      paused.push(hook);
    }
    return await task();
  } finally {
    // Resume in reverse order; keep going if one resume fails.
    const errors: unknown[] = [];
    for (const hook of [...paused].reverse()) {
      try {
        log(`Resuming: ${hook.resume}`);
        await run(hook.resume);
      } catch (err) {
        errors.push(err);
        log(`Resume failed: ${hook.resume}`);
      }
    }
    if (errors.length > 0) {
      // Surface resume failures loudly; the owner's apps may still be paused.
      console.error(`${errors.length} GPU resume command(s) failed. Check your paused processes.`);
    }
  }
}
