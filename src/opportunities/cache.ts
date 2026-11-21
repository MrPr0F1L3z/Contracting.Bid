import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Db } from "../db/db.js";
import type { SamGovSource } from "./samgov.js";
import type { Opportunity, OpportunitySource } from "./types.js";

/** The listings read from a source at one time. */
export interface ListingSnapshot {
  source: string;
  /** ISO time of the read. */
  fetchedAt: string;
  /** Requests the read made. */
  requests: number;
  opportunities: Opportunity[];
}

/** Where the last snapshot is kept between runs. */
export interface ListingStore {
  read(source: string): Promise<ListingSnapshot | null>;
  write(snapshot: ListingSnapshot): Promise<void>;
}

const isSnapshot = (v: unknown): v is ListingSnapshot =>
  v !== null && typeof v === "object" && typeof (v as ListingSnapshot).fetchedAt === "string" && Array.isArray((v as ListingSnapshot).opportunities);

/** Keeps snapshots in a JSON file, for runs without a database. */
export class FileListingStore implements ListingStore {
  constructor(private readonly path: string) {}

  async read(source: string): Promise<ListingSnapshot | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const all = JSON.parse(text) as unknown;
    const s = all !== null && typeof all === "object" ? (all as Record<string, unknown>)[source] : undefined;
    return isSnapshot(s) ? s : null;
  }

  async write(snapshot: ListingSnapshot): Promise<void> {
    let all: Record<string, unknown> = {};
    try {
      all = JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>;
    } catch {
      // A missing or broken file is replaced.
    }
    all[snapshot.source] = snapshot;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(all, null, 2)}\n`);
  }
}

/** Keeps snapshots in the listing_cache table (migration 004). */
export class DbListingStore implements ListingStore {
  constructor(private readonly db: Db) {}

  async read(source: string): Promise<ListingSnapshot | null> {
    const r = await this.db.query<{ fetched_at: Date | string; requests: number; listings: unknown }>(
      "SELECT fetched_at, requests, listings FROM listing_cache WHERE source = $1",
      [source],
    );
    const row = r.rows[0];
    if (!row) return null;
    const listings = typeof row.listings === "string" ? (JSON.parse(row.listings) as unknown) : row.listings;
    return {
      source,
      fetchedAt: new Date(row.fetched_at).toISOString(),
      requests: row.requests,
      opportunities: Array.isArray(listings) ? (listings as Opportunity[]) : [],
    };
  }

  async write(s: ListingSnapshot): Promise<void> {
    await this.db.query(
      `INSERT INTO listing_cache (source, fetched_at, requests, listings) VALUES ($1, $2, $3, $4)
       ON CONFLICT (source) DO UPDATE SET fetched_at = EXCLUDED.fetched_at, requests = EXCLUDED.requests, listings = EXCLUDED.listings`,
      [s.source, s.fetchedAt, s.requests, JSON.stringify(s.opportunities)],
    );
  }
}

/**
 * SAM.gov listings through a cache: list() reads SAM.gov only when the cached
 * snapshot is older than maxAgeHours (or there is none). If SAM.gov fails and
 * an older snapshot exists, that snapshot is used and `warn` says so.
 */
export class CachedSource implements OpportunitySource {
  readonly name: string;

  constructor(
    private readonly live: SamGovSource,
    private readonly store: ListingStore,
    private readonly maxAgeHours: number,
    private readonly now: () => Date = () => new Date(),
    private readonly warn: (line: string) => void = () => undefined,
  ) {
    this.name = live.name;
  }

  /** The cached snapshot, refreshed first if it is stale or `force` is set. */
  async snapshot(force = false): Promise<ListingSnapshot> {
    const cached = await this.store.read(this.name);
    const ageHours = cached ? (this.now().getTime() - new Date(cached.fetchedAt).getTime()) / 3_600_000 : Infinity;
    if (cached && !force && ageHours < this.maxAgeHours) return cached;
    try {
      const { opportunities, requests } = await this.live.fetchAll();
      const fresh: ListingSnapshot = { source: this.name, fetchedAt: this.now().toISOString(), requests, opportunities };
      await this.store.write(fresh);
      return fresh;
    } catch (err) {
      if (!cached) throw err;
      this.warn(`${err instanceof Error ? err.message : String(err)}. Using the listings read ${cached.fetchedAt}.`);
      return cached;
    }
  }

  async list(): Promise<Opportunity[]> {
    return (await this.snapshot()).opportunities;
  }

  /**
   * The listing with its description, read once and then kept in the cache.
   * If SAM.gov can't give it now, the run goes ahead with the title as the scope.
   */
  async describe(o: Opportunity): Promise<Opportunity> {
    if (!o.descriptionUrl) return o;
    let described: Opportunity;
    try {
      described = await this.live.describe(o);
    } catch (err) {
      this.warn(`${err instanceof Error ? err.message : String(err)}. Bidding ${o.noticeId} from its title.`);
      return o;
    }
    const cached = await this.store.read(this.name);
    if (cached) {
      const opportunities = cached.opportunities.map((x) => (x.noticeId === o.noticeId ? described : x));
      await this.store.write({ ...cached, opportunities });
    }
    return described;
  }
}
