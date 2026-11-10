import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { FileUserStore, USERNAME, newTotpSecret, newUser, otpauthUrl, passwordProblem, verifyTotp, hashPassword, type UserStore } from "../dashboard/auth.js";
import type { DashboardOptions } from "../dashboard/server.js";

export const DEFAULT_USERS_FILE = "data/dashboard-users.json";
const ISSUER = "Contracting.Bid";
const CODE_TRIES = 3;

type Env = Record<string, string | undefined>;

export const USER_USAGE = `Usage:
  pnpm sim user add NAME       create a dashboard login (password and authenticator app)
  pnpm sim user passwd NAME    change a password
  pnpm sim user reset-code NAME  set up a new authenticator app for a login
  pnpm sim user remove NAME    delete a login
  pnpm sim user list           list logins

Logins are kept in DASHBOARD_USERS_FILE (default ${DEFAULT_USERS_FILE}), readable only by you.`;

export function usersFile(env: Env): string {
  return env.DASHBOARD_USERS_FILE || DEFAULT_USERS_FILE;
}

const truthy = (v: string | undefined) => v !== undefined && ["1", "true", "yes"].includes(v.toLowerCase());

/** Builds the dashboard's settings from the environment. Throws with a message the owner can act on. */
export async function dashboardOptions(
  env: Env,
  runsDir: string,
  port: number,
  read: (path: string) => Promise<Buffer> = (p) => readFile(p),
): Promise<DashboardOptions> {
  const certPath = env.DASHBOARD_TLS_CERT;
  const keyPath = env.DASHBOARD_TLS_KEY;
  if (Boolean(certPath) !== Boolean(keyPath)) throw new Error("Set both DASHBOARD_TLS_CERT and DASHBOARD_TLS_KEY, or neither");
  let tls: DashboardOptions["tls"];
  if (certPath && keyPath) {
    try {
      tls = { cert: await read(certPath), key: await read(keyPath) };
    } catch (err) {
      throw new Error(`Cannot read the TLS certificate or key: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const behindProxy = truthy(env.DASHBOARD_BEHIND_PROXY);
  if (behindProxy && tls) throw new Error("Use DASHBOARD_BEHIND_PROXY or DASHBOARD_TLS_CERT, not both");
  return {
    runsDir,
    port,
    users: new FileUserStore(usersFile(env)),
    ...(env.DASHBOARD_HOST ? { host: env.DASHBOARD_HOST } : {}),
    ...(tls ? { tls } : {}),
    ...(behindProxy ? { behindProxy: true } : {}),
  };
}

export interface UserCommandDeps {
  env?: Env;
  out?: (line: string) => void;
  /** Asks without echoing what is typed. */
  askSecret?: (prompt: string) => Promise<string>;
  /** Asks with echo. */
  ask?: (prompt: string) => Promise<string>;
  store?: UserStore;
  now?: () => number;
}

/** Reads a line from the terminal without showing it. */
export function hiddenQuestion(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput?: (s: string) => void });
    process.stdout.write(prompt);
    write._writeToOutput = () => undefined;
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function visibleQuestion(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** `pnpm sim user ...`. Returns the exit code. */
export async function runUserCommand(argv: string[], deps: UserCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((l: string) => console.log(l));
  const askSecret = deps.askSecret ?? hiddenQuestion;
  const ask = deps.ask ?? visibleQuestion;
  const now = deps.now ?? Date.now;
  const store = deps.store ?? new FileUserStore(usersFile(env));
  const [action, rawName, ...rest] = argv;
  const name = rawName?.toLowerCase();
  const needsName = action === "add" || action === "passwd" || action === "reset-code" || action === "remove";
  if (!action || !["add", "passwd", "reset-code", "remove", "list"].includes(action) || rest.length > 0 || (needsName ? !name : name !== undefined)) {
    out(USER_USAGE);
    return 2;
  }

  const newPassword = async (username: string): Promise<string | null> => {
    const first = await askSecret("New password: ");
    const problem = passwordProblem(first, username);
    if (problem) {
      out(problem);
      return null;
    }
    if ((await askSecret("Type it again: ")) !== first) {
      out("The passwords did not match");
      return null;
    }
    return first;
  };

  /** Shows the secret and asks for a code until it matches, so nobody is locked out by a mistyped secret. */
  const enroll = async (username: string, secret: string): Promise<number | null> => {
    out("Add this login to an authenticator app (1Password, Google Authenticator, Authy, ...).");
    out(`  Secret key: ${secret.replace(/(.{4})/g, "$1 ").trim()}`);
    out(`  Or open this link on the device: ${otpauthUrl(ISSUER, username, secret)}`);
    for (let i = 0; i < CODE_TRIES; i++) {
      const step = verifyTotp(secret, (await ask("Enter the 6-digit code the app shows: ")).replace(/\s/g, ""), now());
      if (step !== null) return step;
      out("That code does not match. Check the secret and the device's clock.");
    }
    return null;
  };

  try {
    if (action === "list") {
      const users = await store.list();
      if (users.length === 0) out("No dashboard logins yet. Create one with: pnpm sim user add NAME");
      for (const u of users) out(`${u.username}  (created ${u.createdAt.slice(0, 10)})`);
      return 0;
    }
    const existing = await store.get(name!);
    if (action === "remove") {
      if (!(await store.remove(name!))) {
        out(`No login named ${name}`);
        return 1;
      }
      out(`Removed ${name}. Restart a running dashboard to sign it out.`);
      return 0;
    }
    if (action === "add") {
      if (!USERNAME.test(name!)) {
        out("A login name is 2-32 lowercase letters, digits, dots, dashes or underscores");
        return 1;
      }
      if (existing) {
        out(`${name} already exists. Use passwd or reset-code to change it.`);
        return 1;
      }
      const password = await newPassword(name!);
      if (password === null) return 1;
      const user = await newUser(name!, password, new Date(now()));
      const step = await enroll(user.username, user.totpSecret);
      if (step === null) {
        out("Nothing was saved. Run the command again.");
        return 1;
      }
      await store.put({ ...user, lastTotpStep: step });
      out(`Created ${user.username}.`);
      return 0;
    }
    if (!existing) {
      out(`No login named ${name}`);
      return 1;
    }
    if (action === "passwd") {
      const password = await newPassword(existing.username);
      if (password === null) return 1;
      await store.put({ ...existing, passwordHash: await hashPassword(password) });
      out(`Changed the password for ${existing.username}. Restart a running dashboard to sign out its sessions.`);
      return 0;
    }
    const secret = newTotpSecret();
    const step = await enroll(existing.username, secret);
    if (step === null) {
      out("Nothing was changed. The old authenticator still works.");
      return 1;
    }
    await store.put({ ...existing, totpSecret: secret, lastTotpStep: step });
    out(`Set up a new authenticator for ${existing.username}. The old one no longer works.`);
    return 0;
  } catch (err) {
    out(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
