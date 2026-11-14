import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Copies the settings in a .env file into `env`. A variable already set (for example with
 * `export`) wins over the file. A missing file is fine. Returns the names it set.
 */
export function loadDotEnv(path = ".env", env: Record<string, string | undefined> = process.env): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const set: string[] = [];
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (env[name] !== undefined) continue;
    env[name] = value;
    set.push(name);
  }
  return set;
}
