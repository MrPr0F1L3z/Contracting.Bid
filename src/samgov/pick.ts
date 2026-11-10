import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SeededRng } from "../sim/rng.js";
import type { Opportunity } from "./client.js";
import { CONSTRUCTION_NAICS_PREFIXES } from "./client.js";

/** Solicitation notice types that a contractor can bid on. */
const BIDDABLE_TYPES = ["solicitation", "combined synopsis/solicitation"];

/** True when an opportunity is an active, biddable construction solicitation. */
export function isBiddableConstruction(opp: Opportunity): boolean {
  const naicsOk = CONSTRUCTION_NAICS_PREFIXES.some((p) => opp.naicsCode?.startsWith(p));
  const typeOk = BIDDABLE_TYPES.includes((opp.type ?? "").toLowerCase());
  return opp.active && naicsOk && typeOk;
}

/**
 * Picks one opportunity at random (by seed) from the biddable ones.
 * Sorting by noticeId first makes the pick independent of API result order.
 */
export function pickOpportunity(opportunities: Opportunity[], rng: SeededRng): Opportunity {
  const candidates = opportunities
    .filter(isBiddableConstruction)
    .sort((a, b) => a.noticeId.localeCompare(b.noticeId));
  if (candidates.length === 0) {
    throw new Error("No active construction solicitations to pick from");
  }
  return rng.fork("opportunity").pick(candidates);
}

/** Saves the listings a run used, so the run can be replayed offline. */
export async function saveListingCache(path: string, opportunities: Opportunity[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ savedAt: new Date().toISOString(), opportunities }, null, 2));
}

export async function loadListingCache(path: string): Promise<Opportunity[]> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const list = (parsed as { opportunities?: unknown }).opportunities;
  if (!Array.isArray(list)) throw new Error(`${path} is not a listing cache`);
  return list as Opportunity[];
}
