-- A session the daemon owns: an agent running a harness, or a shell session (harness NULL).
-- Live while ended_at is NULL; the daemon stays up while any session is live.
-- Hook calls authenticate with a per-session token; only its SHA-256 is stored.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  harness TEXT CHECK (harness IN ('claude', 'codex')),
  hook_token_sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT
);

CREATE INDEX sessions_live ON sessions (id) WHERE ended_at IS NULL;
