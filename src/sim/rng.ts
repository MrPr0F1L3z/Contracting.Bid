/**
 * Seeded pseudo-random number generator (mulberry32).
 * Every random choice in a simulation run goes through one of these so the
 * run can be replayed exactly from its seed.
 */
export class SeededRng {
  private state: number;

  constructor(readonly seed: number) {
    if (!Number.isInteger(seed)) {
      throw new Error(`Seed must be an integer, got ${seed}`);
    }
    this.state = seed >>> 0;
  }

  /** Returns a float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns an integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new Error(`Invalid range [${min}, ${max}]`);
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Returns one element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("Cannot pick from an empty list");
    }
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Returns `count` distinct elements, in random order. */
  sample<T>(items: readonly T[], count: number): T[] {
    if (count < 0 || count > items.length) {
      throw new Error(`Cannot sample ${count} from ${items.length} items`);
    }
    const pool = [...items];
    const out: T[] = [];
    for (let i = 0; i < count; i++) {
      const j = this.int(0, pool.length - 1);
      out.push(pool.splice(j, 1)[0] as T);
    }
    return out;
  }

  /**
   * Derives an independent generator for a named stream (for example
   * "problems" or "vendor-prices"), so adding draws to one stream never
   * shifts the values another stream sees.
   */
  fork(label: string): SeededRng {
    return new SeededRng(hashString(`${this.seed}:${label}`));
  }
}

/** FNV-1a 32-bit hash of a string. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Makes a new random seed for a fresh run. */
export function newSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 0xffffffff) >>> 0;
}
