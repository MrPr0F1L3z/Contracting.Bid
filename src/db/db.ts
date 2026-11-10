import pg from "pg";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * The small slice of a SQL client the app uses. Postgres (`pg`) backs it in
 * real runs; tests use an embedded Postgres (PGlite) through the same shape.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Runs several statements with no parameters, such as a migration file. */
  exec(sql: string): Promise<void>;
  /** Runs fn in one transaction: all of it commits, or none of it does. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** A Db on a `pg` connection pool. */
export class PgDb implements Db {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, poolSize = 5) {
    this.pool = new pg.Pool({ connectionString, max: poolSize });
    // An idle client can lose its connection (for example when Postgres restarts); log it instead of crashing.
    this.pool.on("error", (err) => console.error(`Postgres connection error: ${err.message}`));
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pool.query(sql, params);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Db = {
      query: async <R>(sql: string, params: unknown[] = []) => {
        const r = await client.query(sql, params);
        return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
      },
      exec: async (sql) => void (await client.query(sql)),
      transaction: (inner) => inner(tx),
      close: async () => undefined,
    };
    try {
      await client.query("BEGIN");
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Opens the database named by DATABASE_URL, or returns null when it is not set. */
export function openDb(env: Record<string, string | undefined>): Db | null {
  const url = env.DATABASE_URL?.trim();
  return url ? new PgDb(url) : null;
}

/** Hides a password in a connection string, for messages. */
export function redactUrl(url: string): string {
  return url.replace(/(\/\/[^:/@]+:)[^@]*@/, "$1***@");
}
