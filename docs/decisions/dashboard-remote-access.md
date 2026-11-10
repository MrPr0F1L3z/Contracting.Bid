# Dashboard: remote access, HTTPS and logins (2026-11-10)

The owner needs to reach the dashboard from other devices over the public internet, with HTTPS and logins. This replaces the one-time link token from the first dashboard.

## What changed

- **Logins:** name, password and a 6-digit code from an authenticator app. `pnpm sim user add|passwd|reset-code|remove|list` manages them.
- **HTTPS:** Caddy in Docker Compose (profile `public`) gets a Let's Encrypt certificate for `DASHBOARD_DOMAIN` and forwards to the dashboard on 127.0.0.1. Or the dashboard serves HTTPS itself from certificate files.
- **Safety:** lockout after 5 failed logins, CSRF protection, strict cookies, HSTS, and no plain HTTP beyond this machine.
- **Audit:** approvals record who decided, as `owner:NAME`.
- Postgres now binds to 127.0.0.1, so opening the machine to the internet cannot expose the database.

## Made while building (please review)

1. **A second factor is required, not optional.** The page approves bids and payments, and you chose the public internet, so a leaked password alone should not be enough. *Question:* is an authenticator app OK, or do you want passkeys (Face ID or Touch ID) later?
2. **Caddy is the recommended way in.** It handles certificates and renewals and keeps the app off the internet. You need a domain pointed at your IP, and ports 80 and 443 forwarded.
3. **Logins live in a file for now** (`data/dashboard-users.json`, mode 600, ignored by git and Docker). They move to a Postgres table in the DB layer, which is next.
4. **Sessions live in memory.** Restarting the dashboard signs everyone out. Sessions end after an hour idle or 12 hours.
5. **Every login has the same powers.** There are no roles yet. *Question:* will anyone besides you sign in? If so, should some people only view?
6. **The dashboard still runs only while a run is going** (or while `pnpm sim dashboard` is open). An always-on service comes with the DB layer, when runs outlive a single command.
7. **No new dependencies.** Password hashing (scrypt) and authenticator codes use Node's built-in crypto.
