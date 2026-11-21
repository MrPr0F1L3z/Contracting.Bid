-- The last listings read from a job source such as SAM.gov, one row per source.
-- SAM.gov allows only a few requests a day per API key, so runs and the dashboard
-- read listings from here and refresh them at most every SAMGOV_CACHE_HOURS.
CREATE TABLE listing_cache (
  source      TEXT PRIMARY KEY,
  fetched_at  TIMESTAMPTZ NOT NULL,
  requests    INT NOT NULL DEFAULT 0,
  listings    JSONB NOT NULL
);
