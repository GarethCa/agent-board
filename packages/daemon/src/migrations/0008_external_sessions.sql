-- An external session: a harness session agent-board did not spawn, reported by the opt-in global hooks.
-- id is '<harness>:<session_id>'. worktree is the git working tree its cwd is in, repo_root that tree's main repo
-- (the same, unless worktree is a linked worktree), folder the cwd inside worktree; all NULL/'' outside git.
-- The zone it is drawn in is worked out from these whenever it is read, so zones added later pick it up.
-- state is the agent state its hooks last put it in (ADR-0004). Live while ended_at is NULL.
-- dismissed_at is set when the user takes a live session off the board: it is kept, out of sight, so its next hooks
-- don't bring it back, until a SessionStart does. A session ended (or ending) while dismissed is deleted.
CREATE TABLE external_sessions (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL CHECK (harness IN ('claude', 'codex')),
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  worktree TEXT,
  repo_root TEXT,
  folder TEXT NOT NULL DEFAULT '',
  branch TEXT,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('running', 'thinking', 'waiting', 'needs-permission', 'idle', 'rate-limited', 'failed', 'done')),
  transcript_path TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_event_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT,
  dismissed_at TEXT
);
