-- Contracting.Bid POC schema. See docs/ARCHITECTURE.md for the data model.
-- Applied automatically by the Postgres container on first start.

CREATE TABLE companies (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  owner       TEXT NOT NULL,
  settings    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  company_id        BIGINT NOT NULL REFERENCES companies(id),
  seed              BIGINT NOT NULL,
  scenario_version  TEXT NOT NULL,
  model_config      JSONB NOT NULL,
  report            JSONB,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);

CREATE TABLE agents (
  id            BIGSERIAL PRIMARY KEY,
  company_id    BIGINT NOT NULL REFERENCES companies(id),
  role          TEXT NOT NULL,
  instructions  TEXT NOT NULL,
  model         TEXT NOT NULL,
  budget_usd    NUMERIC(12, 4) NOT NULL,
  manager_id    BIGINT REFERENCES agents(id),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending_approval', 'active', 'paused', 'retired')),
  config_rev    INT NOT NULL DEFAULT 1
);

CREATE TABLE agent_config_history (
  agent_id      BIGINT NOT NULL REFERENCES agents(id),
  rev           INT NOT NULL,
  config        JSONB NOT NULL,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, rev)
);

CREATE TABLE opportunities (
  id              BIGSERIAL PRIMARY KEY,
  company_id      BIGINT NOT NULL REFERENCES companies(id),
  source          TEXT NOT NULL DEFAULT 'samgov',
  notice_id       TEXT NOT NULL,
  title           TEXT NOT NULL,
  scope           JSONB NOT NULL DEFAULT '{}',
  due_sim_tick    INT,
  decision        TEXT CHECK (decision IN ('pursue', 'no_bid'))
);

CREATE TABLE vendors (
  id          BIGSERIAL PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  kind        TEXT NOT NULL CHECK (kind IN ('vendor', 'subcontractor')),
  name        TEXT NOT NULL,
  trade       TEXT NOT NULL,
  rating      NUMERIC(3, 2)
);

CREATE TABLE estimates (
  id              BIGSERIAL PRIMARY KEY,
  opportunity_id  BIGINT NOT NULL REFERENCES opportunities(id),
  line_items      JSONB NOT NULL,
  margin_pct      NUMERIC(5, 2) NOT NULL
);

CREATE TABLE quotes (
  id            BIGSERIAL PRIMARY KEY,
  estimate_id   BIGINT REFERENCES estimates(id),
  vendor_id     BIGINT NOT NULL REFERENCES vendors(id),
  items         JSONB NOT NULL,
  price_usd     NUMERIC(14, 2) NOT NULL,
  expires_tick  INT
);

CREATE TABLE bids (
  id              BIGSERIAL PRIMARY KEY,
  opportunity_id  BIGINT NOT NULL REFERENCES opportunities(id),
  estimate_id     BIGINT NOT NULL REFERENCES estimates(id),
  amount_usd      NUMERIC(14, 2) NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'won', 'lost', 'withdrawn')),
  submitted_tick  INT
);

CREATE TABLE projects (
  id                  BIGSERIAL PRIMARY KEY,
  bid_id              BIGINT NOT NULL REFERENCES bids(id),
  contract_value_usd  NUMERIC(14, 2) NOT NULL,
  schedule            JSONB NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL CHECK (status IN ('contracted', 'in_progress', 'closeout', 'closed'))
);

CREATE TABLE commitments (
  id          BIGSERIAL PRIMARY KEY,
  project_id  BIGINT NOT NULL REFERENCES projects(id),
  vendor_id   BIGINT NOT NULL REFERENCES vendors(id),
  kind        TEXT NOT NULL CHECK (kind IN ('purchase_order', 'subcontract')),
  scope       TEXT NOT NULL,
  price_usd   NUMERIC(14, 2) NOT NULL,
  start_tick  INT,
  end_tick    INT
);

CREATE TABLE change_orders (
  id          BIGSERIAL PRIMARY KEY,
  project_id  BIGINT NOT NULL REFERENCES projects(id),
  cause       TEXT NOT NULL,
  cost_usd    NUMERIC(14, 2) NOT NULL,
  days        INT NOT NULL DEFAULT 0,
  status      TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'disputed', 'rejected'))
);

CREATE TABLE invoices (
  id             BIGSERIAL PRIMARY KEY,
  project_id     BIGINT NOT NULL REFERENCES projects(id),
  commitment_id  BIGINT REFERENCES commitments(id),
  direction      TEXT NOT NULL CHECK (direction IN ('ar', 'ap')),
  amount_usd     NUMERIC(14, 2) NOT NULL,
  due_tick       INT,
  paid_tick      INT
);

CREATE TABLE tasks (
  id          BIGSERIAL PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  title       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'blocked', 'done')),
  owner_id    BIGINT REFERENCES agents(id),
  parent_id   BIGINT REFERENCES tasks(id),
  project_id  BIGINT REFERENCES projects(id),
  due_tick    INT,
  -- Atomic checkout: an agent claims a task with
  -- UPDATE tasks SET checked_out_by = $1 WHERE id = $2 AND checked_out_by IS NULL
  checked_out_by BIGINT REFERENCES agents(id)
);

CREATE TABLE approvals (
  id            BIGSERIAL PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  gate          TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  summary       TEXT NOT NULL,
  amount_usd    NUMERIC(14, 2),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by    TEXT,
  reason        TEXT,
  auto_approved BOOLEAN NOT NULL DEFAULT false
);

-- Append-only: the app never updates or deletes rows here.
CREATE TABLE events (
  run_id    TEXT NOT NULL REFERENCES runs(id),
  seq       BIGINT NOT NULL,
  type      TEXT NOT NULL,
  actor     TEXT NOT NULL,
  sim_time  INT NOT NULL,
  payload   JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX events_type_idx ON events (run_id, type);
