# The customer site on the cPanel host

The customer site (`web/`) is served from the cPanel host as plain files: a static export of the Next.js site, with Apache rules for redirects and headers. The owner dashboard and the simulation stacks (docs/STACKS.md) stay on your own machine; they need Docker and Postgres, which shared cPanel hosting does not run.

| Target | Address | Comes from | Search engines |
|---|---|---|---|
| staging | https://staging.contracting.bid | every push to `main` that changes the site | blocked (robots.txt and `X-Robots-Tag: noindex`) |
| production | https://www.contracting.bid | a build that passed staging, promoted by hand in the maintenance window | allowed, except the private screens |

Every request to `contracting.bid`, `http://` or `https://`, and to `http://www.contracting.bid`, gets one `301` to `https://www.contracting.bid` with the same path and query. `http://staging.contracting.bid` goes to `https://staging.contracting.bid` the same way. Requests under `/.well-known/` are never redirected, so AutoSSL can renew the certificates.

Nothing on the server is edited by hand. Every change there (the subdomain, certificates, the site's files, the `.htaccess` rules) is made by a workflow running `pnpm cpanel`, from what is committed in this repository.

## First time

### 1. Store the deploy key and host in GitHub (on your machine)

You need: the deploy key in `~/.ssh` (a private key with `deploy` in its name, no passphrase, whose public half is authorized in cPanel > SSH Access), the cPanel SSH host name, user name and port, and the GitHub CLI signed in (`gh auth login`).

```bash
pnpm cpanel setup
```

It:

1. picks the key in `~/.ssh` with `deploy` in its name (asks which if there are several),
2. asks for the host, user, port and domain,
3. reads the host's SSH key and shows its fingerprints. **Compare them with the ones cPanel or your host's support shows before you answer yes.** This is what stops anyone from pretending to be your host later,
4. connects once (read only: it lists the account's domains),
5. lists exactly what it will store in GitHub, and stores it only when you say yes:

| Name | Kind | What |
|---|---|---|
| `CPANEL_SSH_KEY` | secret | the private key (sent to `gh` on stdin; never printed) |
| `CPANEL_KNOWN_HOSTS` | secret | the host's SSH key, as checked in step 3 |
| `CPANEL_HOST`, `CPANEL_USER`, `CPANEL_PORT` | secrets | where to connect |
| `CPANEL_DOMAIN` | variable | `contracting.bid` |
| `CPANEL_ENABLED` | variable | `true`: turns the deploy workflows on. Until it is set, they skip. |

### 2. Protect production (on GitHub)

In the repository, **Settings > Environments**, create `production` (and `staging`) if they are not there after the first run, and on `production` add yourself under **Required reviewers**. Then nothing can run against the live site, including provisioning, without you approving that run. (Required reviewers on a private repository need a paid GitHub plan; without one, only people with write access can run the workflows, which today is you.)

### 3. Create the staging subdomain and the certificates

On GitHub: **Actions > cPanel provision > Run workflow**.

- With **apply** off, it only reports: whether `staging.contracting.bid` exists, what each name resolves to in DNS, and which names have a trusted certificate.
- With **apply** on, it creates `staging.contracting.bid` with its own folder (`~/staging.contracting.bid`, outside the live site's folder) and asks AutoSSL for certificates, then waits up to ten minutes and checks `www.contracting.bid`, `contracting.bid` and `staging.contracting.bid` each have a trusted certificate with at least a week left. Running it again only adds what is missing.

If the domain's DNS is on cPanel, the subdomain's DNS record is made with it. If DNS is somewhere else (Cloudflare, your registrar), add an `A` record for `staging` pointing at the same address as `www` there, wait for it to resolve, and run provision with **apply** again so AutoSSL can issue the certificate. The run says which names do not resolve.

### 4. First deploys

- **Staging** deploys by itself on the next push to `main` that touches `web/`. To deploy now: **Actions > Web staging > Run workflow**.
- **Production**: **Actions > Web production > Run workflow**. Leave **dry_run** on the first time. It lists every file it would send and every file it would remove. If the live folder holds an older site that the pipeline did not put there, it lists those files and will not remove them unless you tick **replace_existing**. Look at that list before you do: a backup is taken first either way, but anything else that lives in that folder (another app, mail autoconfig files) would go.

## Every day

```
merge to main ──► Web staging: build, back up staging, sync, check ──► PASS / FAIL
                                                                         │
            Web production (by hand, in the window) ◄────────────────────┘
            refuses a commit that did not pass staging; backs up, syncs, checks;
            puts the backup back if any check fails
```

Production promotes only a commit that has a successful **Web staging** run, and only inside the prod maintenance window: every night 22:00 to 06:00 Pacific (`PROD_MAINTENANCE_WINDOW` and `PROD_MAINTENANCE_TZ`, the same setting as the dashboard stack; change them as repository variables). **outside_window** is for emergencies and is logged as a warning. A commit that did not touch the site has no staging run of its own; run **Web staging** on it first.

After every deploy, and on its own with `pnpm cpanel check staging|production`, these are checked against the live hostnames:

- each redirect above goes to the right `https://` address with the path and query kept,
- the home page answers `200` over HTTPS (which also proves the certificate is trusted and current),
- `robots.txt` (staging blocks everything; production blocks the private screens), and `noindex` on staging,
- an unknown page gets the 404 page,
- `/build.txt` names the commit that was just deployed.

If one fails, the previous files are put back from the backup and the run fails.

## Commands

```
pnpm cpanel setup                         on your machine, once (above)
pnpm cpanel provision [--apply]           the staging subdomain and certificates
pnpm cpanel check staging|production [--commit SHA]
pnpm cpanel rollback staging|production [--backup PATH]   put the newest (or named) backup back
pnpm cpanel window                        whether now is inside the prod maintenance window
pnpm cpanel stamp ... / deploy ...        used by the workflows
```

`provision`, `deploy` and `rollback` need `CPANEL_HOST`, `CPANEL_USER`, `CPANEL_PORT`, `CPANEL_KEY_FILE` and `CPANEL_KNOWN_HOSTS_FILE`; the workflows set them from the secrets. To roll back by hand from your machine, set them in `.env` (the key file and `~/.ssh/contracting-bid-cpanel-known_hosts` that setup wrote).

## On the host

| Path | What |
|---|---|
| the main domain's document root (usually `~/public_html`) | production. Folders of other domains inside it, `.well-known/`, `cgi-bin/`, `.user.ini`, `php.ini` and `error_log` are never touched |
| `~/staging.contracting.bid` | staging |
| `~/.contracting-bid-deploy/backups/` | the last 5 backups of each target, taken before every deploy (`<target>-<UTC time>.tar.gz`) |

The host needs SSH access with `uapi`, `rsync` and `tar`; provision checks for them.

## Files

- `src/cpanel/site.ts`: the hostnames for each target, the `.htaccess` rules and the build stamp
- `src/cpanel/uapi.ts`: the cPanel calls (domains, subdomain, AutoSSL, installed certificates)
- `src/cpanel/remote.ts`: ssh and rsync arguments, backup and restore
- `src/cpanel/check.ts`: the checks against the live site
- `src/cpanel/setup.ts`, `src/cli/cpanel.ts`: `pnpm cpanel`
- `.github/workflows/cpanel-provision.yml`, `web-staging.yml`, `web-production.yml`, `.github/actions/cpanel-ssh/`
