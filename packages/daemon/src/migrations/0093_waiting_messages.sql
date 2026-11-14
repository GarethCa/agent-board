-- backward-safe: it adds a table and its index, which an older daemon never reads or writes, and deletes rows it would only have flagged again.
-- What waits for an agent's turn to end before it is typed (`Agent.messagesWaiting`), oldest first by id: kept until it
-- is typed, handed back or dropped, so a daemon restart types it once the agent is resumed and its turn ends.
CREATE TABLE waiting_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES agents (session_id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  -- The agent that sent it, told if it is never delivered; NULL for the user's own.
  from_session_id TEXT,
  -- For a notice the board types itself, that a message to another agent was not delivered: that agent.
  about_session_id TEXT,
  -- For such a notice: how many messages it says were not delivered.
  lost INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX waiting_messages_session ON waiting_messages (session_id);
-- Before, what waited went at shutdown to its receiver as not delivered, for the user to resend: one another agent sent
-- (its sender mark first) is not the user's, and its sender carried on. Dropped, so its receiver shows nothing for it.
DELETE FROM undelivered_messages
WHERE what = 'A message'
  AND reason = 'the daemon shut down before its turn ended'
  AND (text LIKE '⟨send from %' OR text LIKE '⟨reply from %');
