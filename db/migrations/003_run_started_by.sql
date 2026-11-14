-- Who started a run from the always-on dashboard ("dashboard:NAME"); empty for terminal runs.
-- The service uses it to mark its own runs "interrupted" when a restart cuts them off.
ALTER TABLE runs ADD COLUMN started_by TEXT;
