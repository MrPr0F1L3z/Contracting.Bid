import type { Stack } from "../config/stack.js";
import type { Db } from "../db/db.js";
import { CachedSource, DbListingStore, FileListingStore } from "./cache.js";
import { SamGovSource, samGovSettings, type SamFetch } from "./samgov.js";
import { StubOpportunitySource } from "./stub.js";
import type { OpportunitySource } from "./types.js";

export const JOB_SOURCES = ["stub", "samgov"] as const;
export type JobSourceName = (typeof JOB_SOURCES)[number];

/** Where the listings cache lives when there is no database. */
export const DEFAULT_CACHE_FILE = "data/samgov-listings.json";

/** JOB_SOURCE (or a --source flag) as a source name; stub when unset. Throws on anything else. */
export function jobSourceName(value: string | undefined): JobSourceName {
  const v = value?.trim().toLowerCase() ?? "";
  if (v === "") return "stub";
  if ((JOB_SOURCES as readonly string[]).includes(v)) return v as JobSourceName;
  throw new Error(`JOB_SOURCE must be ${JOB_SOURCES.join(" or ")}, not "${value}"`);
}

/**
 * The job source on a stack. Dev and staging take JOB_SOURCE (staging sets it in
 * deploy/stacks/staging.env). Prod only ever reads SAM.gov: the stub's made-up
 * jobs are sim data, so asking prod for them is refused.
 */
export function jobSourceForStack(stack: Stack, value: string | undefined): JobSourceName {
  if (stack !== "prod") return jobSourceName(value);
  const v = value?.trim().toLowerCase() ?? "";
  if (v !== "" && v !== "samgov") throw new Error(`The prod stack only reads jobs from SAM.gov, never sim data, so its job source is always samgov, not "${value}".`);
  return "samgov";
}

export interface JobSourceDeps {
  db?: Db | null;
  fetch?: SamFetch;
  now?: () => Date;
  warn?: (line: string) => void;
}

/**
 * The job source a run or the dashboard reads listings from. SAM.gov listings
 * are cached in the database when there is one, or in SAMGOV_CACHE_FILE.
 */
export function jobSource(name: JobSourceName, env: Record<string, string | undefined>, deps: JobSourceDeps = {}): OpportunitySource {
  if (name === "stub") return new StubOpportunitySource();
  const settings = samGovSettings(env);
  const hours = env.SAMGOV_CACHE_HOURS?.trim() ? Number(env.SAMGOV_CACHE_HOURS) : 24;
  if (!Number.isFinite(hours) || hours < 0 || hours > 720) throw new Error(`SAMGOV_CACHE_HOURS must be a number of hours from 0 to 720, not "${env.SAMGOV_CACHE_HOURS}"`);
  const store = deps.db ? new DbListingStore(deps.db) : new FileListingStore(env.SAMGOV_CACHE_FILE?.trim() || DEFAULT_CACHE_FILE);
  return new CachedSource(new SamGovSource(settings, deps.fetch, deps.now), store, hours, deps.now, deps.warn);
}
