# Decisions: the customer site on cPanel (2026-11-21)

The owner asked for a CI/CD pipeline to the cPanel host using the SSH deploy key in `~/.ssh`, a `staging.contracting.bid` subdomain, every `contracting.bid` request redirected to `https://www.contracting.bid`, and SSL for `staging.*` and `www.*`.

## What goes on cPanel

**The customer site (`web/`), as a static export.** The owner dashboard and simulation stacks need Docker and Postgres and stay on the owner's machine (docs/STACKS.md). The site has no server code today (sample data, no sign-in), so `next build` with `output: 'export'` (opt-in with `CB_STATIC_EXPORT=1`) gives plain files that Apache serves with no Node process on the host. When the site gets a real back end, revisit: cPanel's Node.js app support (Passenger) or a different host.

## The key and the secrets

This project cannot reach the owner's computer, so the key in `~/.ssh` could not be read from here, and it should not be: the private key never passes through chat or a cloud session. `pnpm cpanel setup` runs on the owner's machine, sends the key to `gh secret set` on stdin, and stores nothing until the owner has compared the host key fingerprints and said yes to the listed secrets.

The host key is pinned (`CPANEL_KNOWN_HOSTS`, `StrictHostKeyChecking=yes`) instead of trusting whatever answers on first connect.

## Changes on the host only through the pipeline

The owner's rule is never to edit files on a server by hand. Provisioning (subdomain, AutoSSL) and deploys are workflows running `pnpm cpanel`; `.htaccess` is generated from `src/cpanel/site.ts` on every deploy and says not to edit it on the server.

## Staging and production

- Staging deploys on every push to `main` that changes the site. Production is promoted by hand, only a commit that passed staging, only in the existing prod maintenance window (nightly 22:00-06:00 Pacific), with `dry_run` on by default and an `outside_window` emergency switch. This is the same dev -> staging -> prod flow as the stacks. The stacks' gate of 10 unattended closeout runs is about the simulation and does not apply to a static site; the site's gate is "this exact commit passed staging's checks".
- Staging gets its own folder outside the live one (`~/staging.<domain>`), so a production sync can never delete it. Folders of other domains that do live inside the production folder are found from cPanel and left alone, as are `.well-known/` and `cgi-bin/`.
- A backup is taken before every deploy (last 5 kept); a failed check puts it back.
- The first production deploy will not remove files that the pipeline did not put there unless the owner ticks `replace_existing` after looking at the list.

## Redirects and SSL

- One `301` from any non-canonical name or plain http straight to `https://www.contracting.bid`, path and query kept. `/.well-known/` is exempt so AutoSSL (cPanel's Let's Encrypt/Sectigo) can validate and renew.
- AutoSSL rather than a certificate we manage: cPanel renews it by itself. Provision asks for a check and verifies that `www`, the bare domain (needed for the https redirect) and `staging` each have a trusted certificate with a week or more left.
- HSTS is sent without `includeSubDomains` or preload for now, so a future subdomain without a certificate is not locked out.
- Rules avoid `<If>` blocks so they work on both Apache and LiteSpeed, which many cPanel hosts run.

## Open for the owner

- Turn on **Required reviewers** for the `production` environment (docs/CPANEL.md, step 2).
- If DNS is not on cPanel, add the `staging` A record where it lives.
