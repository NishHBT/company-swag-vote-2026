-- Company Swag Vote 2026 — D1 schema.
-- One anonymous ballot per browser identifier; one row per product rating.
-- Vote choices live only in D1. They are never written back into the static site.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ballots (
  id            TEXT PRIMARY KEY,           -- server-generated UUID
  browser_id    TEXT NOT NULL UNIQUE,       -- anonymous per-browser identifier
  submitted_utc TEXT NOT NULL,              -- 'YYYY-MM-DD HH:MM:SS' UTC
  feedback      TEXT                         -- optional anonymous free-text feedback
);

CREATE TABLE IF NOT EXISTS votes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ballot_id  TEXT NOT NULL REFERENCES ballots(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,                 -- P01..P60, validated against the server catalog
  vote       TEXT NOT NULL CHECK (vote IN ('Like', 'Love', 'Don''t Like')),
  UNIQUE (ballot_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_votes_product ON votes (product_id);
CREATE INDEX IF NOT EXISTS idx_ballots_submitted ON ballots (submitted_utc);
