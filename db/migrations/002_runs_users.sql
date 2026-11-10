-- Runs, their agents and approvals as the sim records them, and dashboard logins.

ALTER TABLE runs
  ADD COLUMN command    TEXT,
  ADD COLUMN profile    TEXT,
  ADD COLUMN outcome    TEXT,
  ADD COLUMN reason     TEXT,
  ADD COLUMN spent_usd  NUMERIC(12, 4);
CREATE INDEX runs_started_idx ON runs (started_at DESC);

-- Agents belong to a run in the sim; agent_no is the agent's number within it.
ALTER TABLE agents
  ADD COLUMN run_id       TEXT REFERENCES runs(id),
  ADD COLUMN agent_no     INT,
  ADD COLUMN manager_no   INT,
  ADD COLUMN hired_by_no  INT,
  ALTER COLUMN model DROP NOT NULL,
  DROP CONSTRAINT agents_status_check,
  ADD CONSTRAINT agents_status_check CHECK (status IN ('pending_approval', 'active', 'paused', 'retired', 'rejected'));
CREATE UNIQUE INDEX agents_run_no_idx ON agents (run_id, agent_no) WHERE run_id IS NOT NULL;

-- approval_no is the approval's number within its run; items are batch approvals.
ALTER TABLE approvals
  ADD COLUMN approval_no     INT,
  ADD COLUMN items           JSONB,
  ADD COLUMN approved_items  JSONB;
CREATE UNIQUE INDEX approvals_run_no_idx ON approvals (run_id, approval_no);

CREATE TABLE dashboard_users (
  username        TEXT PRIMARY KEY,
  password_hash   TEXT NOT NULL,
  totp_secret     TEXT NOT NULL,
  last_totp_step  BIGINT NOT NULL DEFAULT -1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
