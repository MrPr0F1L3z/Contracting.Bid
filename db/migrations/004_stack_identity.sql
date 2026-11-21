-- Which stack (dev, staging or prod) this database belongs to. It has at most one row.
-- The first command to open the database records its APP_STACK here; after that, a process
-- running as another stack refuses to use it, so prod can never write to staging's data.
CREATE TABLE stack_identity (
  only_row    BOOLEAN PRIMARY KEY DEFAULT true CHECK (only_row),
  stack       TEXT NOT NULL CHECK (stack IN ('dev', 'staging', 'prod')),
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
