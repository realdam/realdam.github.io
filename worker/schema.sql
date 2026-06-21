-- Shooting Star community timer — D1 (SQLite) schema.
-- Apply with:  wrangler d1 execute star-timer --remote --file=./schema.sql

DROP TABLE IF EXISTS predictions;

CREATE TABLE predictions (
  id           TEXT PRIMARY KEY,         -- crypto.randomUUID()
  username     TEXT NOT NULL,            -- sanitized, <= 20 chars; cosmetic label, never identity
  min_time     REAL NOT NULL,            -- minutes-from-submit (submitter's relative intent)
  max_time     REAL NOT NULL,            -- minutes-from-submit
  telescope    TEXT,                     -- 'Wooden' | 'Teak' | 'Mahogany' | NULL (optional metadata)
  submitted_at INTEGER NOT NULL,         -- epoch ms, STAMPED BY THE WORKER (never the client)
  abs_min      INTEGER NOT NULL,         -- submitted_at + min_time*60000  (absolute predicted-event window)
  abs_max      INTEGER NOT NULL,         -- submitted_at + max_time*60000
  client_hint  TEXT NOT NULL UNIQUE,     -- sha256(ip); dedupe/cooldown key, NEVER returned to clients
  CHECK (min_time >= 0 AND max_time >= min_time),  -- enforce the window invariant at the DB level
  CHECK (abs_min <= abs_max)                       -- the consensus relies on this holding
);

-- UNIQUE(client_hint) already creates an index, so no separate one is needed for it.
CREATE INDEX idx_predictions_submitted_at ON predictions(submitted_at);
CREATE INDEX idx_predictions_abs_max      ON predictions(abs_max);
