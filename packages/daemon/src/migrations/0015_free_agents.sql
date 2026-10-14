-- Free agents: an agent's tile can sit in any zone, or loose on the board (zone_id NULL, x and y board
-- coordinates), so where it sits no longer says which repo it works in. repo_root records that: the repo its worktree
-- and branch were made in, taken from the zone it was started in. codex_bypass_hook_trust is the last setting it
-- started with from a zone of its repo, kept for when no zone of its repo is left. SQLite can't drop a NOT NULL, so
-- agents is rebuilt with its columns in the same order and the new ones after; migrate() runs this with foreign keys
-- off, so schedules keep their agents. An agent whose zone is missing or unbound can't be (agents start only in bound
-- zones, and binding is one-way), but if one is, its NULL repo_root fails the migration rather than dropping the row.
CREATE TABLE agents_new (
  session_id TEXT PRIMARY KEY REFERENCES sessions (id),
  zone_id TEXT REFERENCES zones (id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  branch TEXT NOT NULL,
  worktree TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'thinking', 'waiting', 'needs-permission', 'idle', 'rate-limited', 'failed', 'done')),
  issue_provider TEXT,
  issue_id TEXT,
  issue_title TEXT,
  issue_url TEXT,
  notice TEXT,
  muted INTEGER NOT NULL DEFAULT 0,
  x REAL,
  y REAL CHECK ((x IS NULL) = (y IS NULL)),
  z REAL,
  repo_root TEXT NOT NULL,
  codex_bypass_hook_trust INTEGER NOT NULL CHECK (codex_bypass_hook_trust IN (0, 1))
);
INSERT INTO agents_new (session_id, zone_id, name, description, branch, worktree, state, issue_provider, issue_id,
    issue_title, issue_url, notice, muted, x, y, z, repo_root, codex_bypass_hook_trust)
  SELECT a.session_id, a.zone_id, a.name, a.description, a.branch, a.worktree, a.state, a.issue_provider, a.issue_id,
    a.issue_title, a.issue_url, a.notice, a.muted, a.x, a.y, a.z, z.repo_root, coalesce(z.codex_bypass_hook_trust, 1)
  FROM agents a LEFT JOIN zones z ON z.id = a.zone_id ORDER BY a.rowid;
DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;
