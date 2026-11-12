-- backward-safe: it only adds two tables, which an older daemon never reads.
-- Paired devices: clients on other machines that reach this daemon. Only a hash of each device's token is kept. A
-- revoked device's row is deleted, never just marked.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('read', 'act')),
  token_sha256 TEXT NOT NULL UNIQUE,
  paired_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_seen_from TEXT
);

-- The audit log of paired devices: each call a device made, and each revocation. It names the device by id and
-- name, so an entry outlives a revoked device's row. Params are never kept; the ids of what a call acted on are.
CREATE TABLE remote_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  address TEXT,
  method TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'refused', 'failed')),
  reason TEXT,
  ids TEXT,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX remote_calls_device ON remote_calls (device_id, id);
