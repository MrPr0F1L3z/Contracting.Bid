import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Shortest password accepted for a dashboard login. */
export const MIN_PASSWORD_LENGTH = 12;
/** Failed logins allowed for one name or address before it is locked out. */
export const MAX_FAILURES = 5;
/** How long failures are remembered, and how long a lockout lasts. */
export const LOCKOUT_MS = 15 * 60_000;
/** A session ends this long after login, whatever happens. */
export const SESSION_MS = 12 * 60 * 60_000;
/** A session also ends after this long without a request. */
export const IDLE_MS = 60 * 60_000;

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 } as const;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, { ...opts, maxmem: 128 * opts.N! * opts.r! * 2 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Hashes a password with scrypt and a random salt, as `scrypt$N$r$p$salt$hash` (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

/** Checks a password against a hash from hashPassword, in constant time. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4]!, "base64");
  const want = Buffer.from(parts[5]!, "base64");
  if (!N || !r || !p || want.length === 0) return false;
  const got = await scrypt(password, salt, want.length, { N, r, p });
  return timingSafeEqual(got, want);
}

/** Why a new password is not acceptable, or null. */
export function passwordProblem(password: string, username: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.toLowerCase().includes(username.toLowerCase())) return "Do not include the login name in the password";
  return null;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error(`Not base32: ${ch}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random authenticator secret, in base32 (160 bits). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The 6-digit RFC 6238 code (SHA-1, 30-second steps) for a time step. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return n.toString().padStart(6, "0");
}

/**
 * Checks a code against the current step and one step either side, for
 * clock drift. Returns the matched step, or null. A step at or before
 * `lastStep` is refused, so a code cannot be used twice.
 */
export function verifyTotp(secret: string, code: string, nowMs: number, lastStep = -1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = Math.floor(nowMs / 30_000);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    const want = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(want, Buffer.from(code))) return step;
  }
  return null;
}

/** The link an authenticator app reads (as a QR code or pasted). */
export function otpauthUrl(issuer: string, username: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export interface DashboardUser {
  username: string;
  passwordHash: string;
  totpSecret: string;
  /** The last authenticator step used, so a code cannot be replayed. */
  lastTotpStep: number;
  createdAt: string;
}

/** Where dashboard logins are kept. A Postgres store replaces the file one in the DB layer. */
export interface UserStore {
  get(username: string): Promise<DashboardUser | null>;
  list(): Promise<DashboardUser[]>;
  put(user: DashboardUser): Promise<void>;
  remove(username: string): Promise<boolean>;
}

export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/** Users kept in one JSON file, readable only by the file's owner (mode 600). */
export class FileUserStore implements UserStore {
  constructor(private readonly path: string) {}

  private async read(): Promise<DashboardUser[]> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8")) as { users?: DashboardUser[] };
      return Array.isArray(data.users) ? data.users : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`Cannot read the dashboard users file ${this.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async write(users: DashboardUser[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify({ users }, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }

  async get(username: string): Promise<DashboardUser | null> {
    return (await this.read()).find((u) => u.username === username) ?? null;
  }
  async list(): Promise<DashboardUser[]> {
    return this.read();
  }
  async put(user: DashboardUser): Promise<void> {
    const users = (await this.read()).filter((u) => u.username !== user.username);
    await this.write([...users, user]);
  }
  async remove(username: string): Promise<boolean> {
    const users = await this.read();
    const kept = users.filter((u) => u.username !== username);
    if (kept.length === users.length) return false;
    await this.write(kept);
    return true;
  }
}

/** A store kept in memory, for tests. */
export class MemoryUserStore implements UserStore {
  private readonly users = new Map<string, DashboardUser>();
  async get(username: string) {
    const u = this.users.get(username);
    return u ? { ...u } : null;
  }
  async list() {
    return [...this.users.values()].map((u) => ({ ...u }));
  }
  async put(user: DashboardUser) {
    this.users.set(user.username, { ...user });
  }
  async remove(username: string) {
    return this.users.delete(username);
  }
}

/** Builds a new user record with a fresh authenticator secret. */
export async function newUser(username: string, password: string, now = new Date()): Promise<DashboardUser> {
  if (!USERNAME.test(username)) throw new Error("A login name is 2-32 lowercase letters, digits, dots, dashes or underscores");
  const problem = passwordProblem(password, username);
  if (problem) throw new Error(problem);
  return { username, passwordHash: await hashPassword(password), totpSecret: newTotpSecret(), lastTotpStep: -1, createdAt: now.toISOString() };
}

export interface Session {
  id: string;
  username: string;
  csrf: string;
  createdAt: number;
  seenAt: number;
}

/** Signed-in sessions, in memory. Restarting the dashboard signs everyone out. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly now: () => number = Date.now) {}

  create(username: string): Session {
    const t = this.now();
    const s = { id: randomBytes(32).toString("base64url"), username, csrf: randomBytes(24).toString("base64url"), createdAt: t, seenAt: t };
    this.sessions.set(s.id, s);
    return { ...s };
  }

  /** The live session for an id, refreshing its idle timer; null if missing or expired. */
  touch(id: string | undefined): Session | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    const t = this.now();
    if (t - s.createdAt > SESSION_MS || t - s.seenAt > IDLE_MS) {
      this.sessions.delete(id);
      return null;
    }
    s.seenAt = t;
    return { ...s };
  }

  end(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  /** Signs a user out everywhere, for example after a password change. */
  endAllFor(username: string): void {
    for (const [id, s] of this.sessions) if (s.username === username) this.sessions.delete(id);
  }
}

/** Counts failed logins per key (a name or an address) and locks a key out after MAX_FAILURES. */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  private recent(key: string): number[] {
    const t = this.now();
    const list = (this.failures.get(key) ?? []).filter((f) => t - f < LOCKOUT_MS);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** Milliseconds until any of these keys may try again, or 0. */
  lockedFor(...keys: string[]): number {
    const t = this.now();
    let wait = 0;
    for (const k of keys) {
      const list = this.recent(k);
      if (list.length >= MAX_FAILURES) wait = Math.max(wait, list[list.length - MAX_FAILURES]! + LOCKOUT_MS - t);
    }
    return wait;
  }

  fail(...keys: string[]): void {
    for (const k of keys) this.failures.set(k, [...this.recent(k), this.now()]);
  }

  succeed(...keys: string[]): void {
    for (const k of keys) this.failures.delete(k);
  }
}

/** Reads one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
