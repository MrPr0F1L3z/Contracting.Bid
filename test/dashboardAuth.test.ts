import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileUserStore, IDLE_MS, LOCKOUT_MS, LoginLimiter, MAX_FAILURES, MemoryUserStore, SESSION_MS, SessionStore,
  base32Decode, base32Encode, hashPassword, newTotpSecret, newUser, otpauthUrl, passwordProblem, readCookie,
  totpCode, verifyPassword, verifyTotp,
} from "../src/dashboard/auth.js";

// RFC 6238 appendix B: the ASCII secret "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("passwords", () => {
  it("hashes with a salt and verifies only the right password", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse batterY", a)).toBe(false);
  });
  it("rejects malformed hashes", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$1$2$3$4$5")).toBe(false);
    expect(await verifyPassword("x", "scrypt$0$8$1$c2FsdA==$aGFzaA==")).toBe(false);
    expect(await verifyPassword("x", "scrypt$16384$8$1$c2FsdA==$")).toBe(false);
  });
  it("names a weak password", () => {
    expect(passwordProblem("short", "owner")).toBe("Use at least 12 characters");
    expect(passwordProblem("my-owner-password", "owner")).toBe("Do not include the login name in the password");
    expect(passwordProblem("a long enough phrase", "owner")).toBeNull();
  });
});

describe("base32", () => {
  it("round-trips and matches the RFC 4648 vectors", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
    expect(base32Decode("mzxw 6ytb-oi==").toString()).toBe("foobar");
    expect(() => base32Decode("MZ1")).toThrow("Not base32: 1");
  });
  it("makes 160-bit secrets", () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(newTotpSecret()).not.toBe(s);
  });
});

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 vectors", () => {
    expect(totpCode(RFC_SECRET, Math.floor(59 / 30))).toBe("287082");
    expect(totpCode(RFC_SECRET, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpCode(RFC_SECRET, Math.floor(1234567890 / 30))).toBe("005924");
  });
  it("accepts one step of drift either way, and nothing older", () => {
    const now = 1111111109_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(RFC_SECRET, "081804", now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now)).toBeNull();
  });
  it("refuses a reused step and malformed codes", () => {
    const now = 1111111109_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(RFC_SECRET, "081804", now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "081804", now, step - 1)).toBe(step);
    expect(verifyTotp(RFC_SECRET, "81804", now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "0818045", now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", now)).toBeNull();
  });
  it("builds the authenticator link", () => {
    expect(otpauthUrl("Contracting.Bid", "owner", "ABC")).toBe(
      "otpauth://totp/Contracting.Bid%3Aowner?secret=ABC&issuer=Contracting.Bid&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("newUser", () => {
  it("builds a record with a hash and a fresh secret", async () => {
    const u = await newUser("owner", "a long enough phrase", new Date("2026-11-10T00:00:00Z"));
    expect(u).toMatchObject({ username: "owner", lastTotpStep: -1, createdAt: "2026-11-10T00:00:00.000Z" });
    expect(await verifyPassword("a long enough phrase", u.passwordHash)).toBe(true);
    expect(u.totpSecret).toMatch(/^[A-Z2-7]{32}$/);
  });
  it("refuses bad names and weak passwords", async () => {
    await expect(newUser("Owner", "a long enough phrase")).rejects.toThrow("A login name is");
    await expect(newUser("o", "a long enough phrase")).rejects.toThrow("A login name is");
    await expect(newUser("owner", "short")).rejects.toThrow("Use at least 12");
  });
});

describe("FileUserStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "users-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const user = (username: string) => ({ username, passwordHash: "h", totpSecret: "S", lastTotpStep: -1, createdAt: "t" });

  it("starts empty, then stores, replaces and removes users in a private file", async () => {
    const path = join(dir, "nested", "users.json");
    const s = new FileUserStore(path);
    expect(await s.list()).toEqual([]);
    expect(await s.get("owner")).toBeNull();
    await s.put(user("owner"));
    await s.put(user("partner"));
    await s.put({ ...user("owner"), lastTotpStep: 5 });
    expect((await s.list()).map((u) => [u.username, u.lastTotpStep])).toEqual([["partner", -1], ["owner", 5]]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await s.remove("partner")).toBe(true);
    expect(await s.remove("partner")).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ users: [{ ...user("owner"), lastTotpStep: 5 }] });
  });
  it("reports a corrupt file instead of treating it as empty", async () => {
    const path = join(dir, "users.json");
    await writeFile(path, "{oops");
    await expect(new FileUserStore(path).list()).rejects.toThrow(`Cannot read the dashboard users file ${path}`);
  });
  it("MemoryUserStore returns copies", async () => {
    const s = new MemoryUserStore();
    await s.put(user("owner"));
    (await s.get("owner"))!.lastTotpStep = 9;
    expect((await s.get("owner"))!.lastTotpStep).toBe(-1);
    expect(await s.remove("owner")).toBe(true);
    expect(await s.list()).toEqual([]);
  });
});

describe("SessionStore", () => {
  it("creates random sessions and ends them on idle, age or sign out", () => {
    let t = 0;
    const s = new SessionStore(() => t);
    const a = s.create("owner");
    expect(a.id).toMatch(/^[\w-]{43}$/);
    expect(a.csrf).not.toBe(a.id);
    expect(s.touch(a.id)).toMatchObject({ username: "owner" });
    expect(s.touch(undefined)).toBeNull();
    expect(s.touch("nope")).toBeNull();
    t += IDLE_MS + 1;
    expect(s.touch(a.id)).toBeNull();
    // Kept alive by use, but never past the absolute limit.
    const b = s.create("owner");
    for (let i = 0; i < SESSION_MS / (IDLE_MS / 2); i++) {
      t += IDLE_MS / 2;
      expect(s.touch(b.id)).not.toBeNull();
    }
    expect(t - b.createdAt).toBe(SESSION_MS);
    t += 1;
    expect(s.touch(b.id)).toBeNull();
    const c = s.create("owner");
    s.end(c.id);
    expect(s.touch(c.id)).toBeNull();
    const d = s.create("owner");
    const e = s.create("partner");
    s.endAllFor("owner");
    expect(s.touch(d.id)).toBeNull();
    expect(s.touch(e.id)).not.toBeNull();
  });
});

describe("LoginLimiter", () => {
  it("locks a key after MAX_FAILURES and frees it after LOCKOUT_MS", () => {
    let t = 0;
    const l = new LoginLimiter(() => t);
    for (let i = 0; i < MAX_FAILURES - 1; i++) l.fail("ip:1", "user:owner");
    expect(l.lockedFor("ip:1")).toBe(0);
    t = 1000;
    l.fail("ip:1", "user:owner");
    // Locked until the oldest of the last MAX_FAILURES failures (at t=0) is forgotten.
    expect(l.lockedFor("ip:1")).toBe(LOCKOUT_MS - 1000);
    expect(l.lockedFor("ip:2", "user:owner")).toBe(LOCKOUT_MS - 1000);
    expect(l.lockedFor("ip:2", "user:other")).toBe(0);
    t = LOCKOUT_MS - 1;
    expect(l.lockedFor("ip:1")).toBe(1);
    t = LOCKOUT_MS;
    expect(l.lockedFor("ip:1")).toBe(0);
  });
  it("clears a key on success", () => {
    const l = new LoginLimiter(() => 0);
    for (let i = 0; i < MAX_FAILURES; i++) l.fail("user:owner");
    l.succeed("user:owner");
    expect(l.lockedFor("user:owner")).toBe(0);
  });
});

describe("readCookie", () => {
  it("finds one cookie by name", () => {
    expect(readCookie("a=1; cb_session=xyz; b=2", "cb_session")).toBe("xyz");
    expect(readCookie("cb_session_old=1", "cb_session")).toBeUndefined();
    expect(readCookie(undefined, "cb_session")).toBeUndefined();
  });
});
