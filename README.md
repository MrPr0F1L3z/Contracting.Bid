# Contracting.Bid

A general contracting company run by AI agents. The agents fill the company's roles, from President down to Bookkeeper, and the human owner only approves hires, money and contracts.

**Status:** sandboxed proof of concept. Nothing here talks to real clients, vendors, banks or bid portals. Jobs come from a stub of made-up federal construction solicitations; a read-only SAM.gov source comes in a later sprint.

## How it works

1. The company starts with one agent, the President (Claude).
2. The President hires HR. HR hires the Project Manager (Claude), then the Estimator, Procurement, Scheduler and Bookkeeper. You approve every hire.
3. The company picks a construction solicitation from the job source, estimates it, gets quotes from simulated vendors and subcontractors, and bids.
4. A world simulator plays the contracting officer, vendors, subcontractors and inspector. Each run injects 3 to 5 problems, such as late deliveries, change orders, failed inspections or late payment.
5. The run ends at closeout, with a report of margin vs. bid, days late, the problems handled, and model cost.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the code layout.

## Requirements

- Node.js 22 and pnpm (`corepack enable`)
- Docker with Compose, for Postgres
- A vLLM server on your machine with an OpenAI-compatible API (default `http://localhost:8000/v1`)
- An Anthropic API key

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in your keys and model name
docker compose up -d db
pnpm check             # typecheck + tests (no keys or GPU needed)
```

`VLLM_MODEL` in `.env.example` is a placeholder; set it to the exact model name your vLLM server reports.

## GPU sharing

Simulations need the GPU. List the commands that pause and resume your other GPU processes in `GPU_PAUSE_HOOKS`, for example:

```bash
GPU_PAUSE_HOOKS='[{"pause":"docker pause my-gpu-app","resume":"docker unpause my-gpu-app"}]'
```

The runner pauses them before a simulation and always resumes them afterwards, even if the run fails. It never kills or removes anything.

## Tests

Every function has unit tests. Tests use scripted stub models and saved fixtures, so they never call Claude, vLLM or SAM.gov and cost nothing.

```bash
pnpm test
pnpm vitest run --coverage
```
