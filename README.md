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
- A vLLM server on your machine with an OpenAI-compatible API (default `http://localhost:8001/v1`)
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

Simulations need the GPU. Ollama and any existing vLLM processes may be stopped for a run. List the commands that stop and restart them in `GPU_PAUSE_HOOKS`. Pausing a process (`docker pause`, `kill -STOP`) keeps its VRAM allocated, so use real stop and start commands, for example:

```bash
GPU_PAUSE_HOOKS='[{"pause":"sudo systemctl stop ollama","resume":"sudo systemctl start ollama"},{"pause":"docker stop vllm","resume":"docker start vllm"}]'
```

The runner runs the stop commands before a simulation and always runs the start commands afterwards, in reverse order, even if the run fails. It runs only the commands you list.

### Reuse or restart vLLM

Before a run, the vLLM check reads `/metrics` for running and queued requests and times one short test request. It reuses the running server unless one of these is true, in which case it runs `vllm_service stop` then `vllm_service start big` and waits for the server to come up:

- all lanes are busy (`VLLM_MAX_LANES`, default 2, matching `--max-num-seqs` in the `big` profile) or requests are queued
- the test request takes longer than `VLLM_MAX_RESPONSE_SEC` (default 60)
- generation is slower than `VLLM_MIN_TOKENS_PER_SEC` (default 5)

```bash
pnpm gpu check           # report lanes and speed, change nothing
pnpm gpu ensure          # reuse, or stop and start fresh
pnpm gpu loadtest 3 3    # 3 background requests, then time 3 more while they run
```

The commands call `/usr/local/bin/vllm_service` directly, because the `vllm` alias only exists in interactive shells. `vllm_service start` uses `sudo systemctl`, so it needs passwordless sudo for that unit or it will stop and ask for a password. Override the commands with `VLLM_STOP_CMD` and `VLLM_START_CMD`.

## Run the hiring chain

```bash
pnpm sim hiring --stub             # dry run with scripted models: no API key, GPU or cost
pnpm sim hiring                    # hybrid: President and PM on Claude, other roles on your local vLLM model
pnpm sim hiring --models cloud     # cloud: every role on Claude; the GPU is not touched
pnpm sim bench --runs 3            # 3 runs of each profile, alternating, then a time and cost comparison
```

The President hires an HR rep, and HR hires a Project Manager. Both hires are automatic. Any other hire an agent proposes asks you in the terminal (`y` approves; anything else rejects, and your text is the reason). A real run checks vLLM first (see above), needs `ANTHROPIC_API_KEY`, and is capped at `RUN_BUDGET_USD` (default $5) of Claude spend. Each run writes a JSON report to `runs/`, including every event and the wall-clock time of each task. A benchmark declines any hire beyond the automatic two, so every run does the same work.

## Tests

Every function has unit tests. Tests use scripted stub models and saved fixtures, so they never call Claude, vLLM or SAM.gov and cost nothing.

```bash
pnpm test
pnpm vitest run --coverage
```
