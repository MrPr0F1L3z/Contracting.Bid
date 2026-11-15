# Contracting.Bid web

The customer-facing site: marketing pages, sign-up, onboarding and the contractor's workspace, in the Blueprint design.

**Status:** front end only. Every job, company and figure is sample data built into the design components. Forms accept anything and nothing is saved. There is no sign-in check, no database and no connection to the simulation in the repo root.

## Run it

From this folder:

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

```bash
pnpm check        # typecheck + unit tests
pnpm build        # production build
pnpm e2e          # browser tests against the production build (run `pnpm build` first)
```

`pnpm e2e` needs Chromium: `pnpm exec playwright install chromium`, or set `PW_CHROMIUM_PATH` to one you already have.

## Two templates

The site is built in one design template at a time. **Blueprint** is the default. **Hi-Vis** is the same site, page for page, in the other design, kept so the two can be compared whole.

```bash
pnpm dev:hivis    # Hi-Vis on http://localhost:3001, alongside `pnpm dev` on 3000
```

```bash
pnpm build:hivis && pnpm start:hivis   # production build of Hi-Vis on 3001
```

```bash
pnpm e2e:hivis    # the browser tests against the Hi-Vis build
```

The switch is the `NEXT_PUBLIC_CB_TEMPLATE` environment variable (`hivis`, anything else is Blueprint). Hi-Vis builds into `.next-hivis`, so both can run at once. These scripts set the variable inline, which works in macOS and Linux shells; on Windows use WSL or set the variable first.

## Routes

| URL | Screen |
| --- | --- |
| `/` | Home |
| `/pricing` | Plans (placeholder plans and prices) |
| `/signup`, `/signin` | Create account, sign in |
| `/reset`, `/reset/sent`, `/reset/new` | Password reset |
| `/onboarding` | Four setup steps |
| `/terms`, `/privacy` | Legal pages (outline only; text to come from counsel) |
| `/trial-ended` | Trial ended |
| `/app` | Workspace overview |
| `/app/<screen>` | `find-work`, `bids`, `bid-detail`, `import-bid`, `award`, `projects`, `project-detail`, `change-order`, `pay-app`, `subs-vendors`, `sub-detail`, `pay-run`, `schedule`, `money`, `closeout`, `settings`, `welcome` |

Unknown URLs get the not-found page with a 404 status. The workspace, onboarding and reset pages are excluded from search engines.

## Layout

| Path | What it does |
| --- | --- |
| `src/app/` | Routes. Each `page.tsx` sets the page's metadata and renders one screen |
| `src/screens/` | Client components that connect a design-system page to the router, plus the analytics hook |
| `src/lib/routes.ts` | The URL scheme: page and screen names to paths and back |
| `src/lib/analytics.ts` | Forwards component events to `window.dataLayer` |
| `src/lib/signupEmail.ts` | Carries the email from the home page form to sign-up without putting it in the URL |
| `src/design/` | The design system: tokens, component styles and components. **Generated; see below** |
| `scripts/` | Imports the design system and compiles tokens to CSS |
| `test/` | Unit tests (Vitest) |
| `e2e/` | Browser tests (Playwright) |

## The design system

`src/design/cb.js`, `cb.d.ts`, `components.css`, `tokens.json` and `test/design.test.js` are imported from the Contracting.Bid design system. Don't edit them here. Change the design system, then:

```bash
pnpm design:import <path to the design system's components folder>
```

```bash
pnpm tokens
```

A unit test fails if `tokens.css` is out of date with `tokens.json`.

The components are one JavaScript module with TypeScript declarations beside it, not one typed file per component. That keeps the app identical to the reviewed design while the product is still taking shape; splitting it into typed source files is a sensible later step.

Always import components from `@/design`, never from `@/design/cb`. `@/design` installs the URL scheme, so links are real URLs in the server-rendered HTML.

## Events and A/B tests

Every button, form and experiment reports through one function. `src/screens/Analytics.tsx` forwards those reports to `window.dataLayer` as `cb_<event>` rows (`cb_click`, `cb_signup_submit`, `cb_account_created`, `cb_onboarding_step`, `cb_onboarding_complete`, `cb_page_view`, `cb_experiment_exposure`). No analytics vendor is connected.

To run a test, wrap the variants in `Experiment` from `@/design` with a stable name and visitor id. Assignment is a deterministic hash of the two, so a visitor always sees the same variant. Elements carry `data-section`, `data-track`, `data-experiment` and `data-variant` for tools and tests to select on. The Hi-Vis and Field templates ship in the module as challengers for the home page.

Not built yet: a persistent visitor id (a first-party cookie set on the server) so assignment is stable before sign-in and the page can stay server-rendered without a flash.

## Not built yet

- Accounts, sessions and access control for `/app`
- An API and real data in place of the sample job book
- Real plans and prices, and the legal text
- Loading states (the component exists; nothing loads yet)
