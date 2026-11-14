-- backward-safe: a new nullable column, which an older daemon never reads or writes.
-- For a plan the agent left (`agent-board doc --plan`, no timer, so `expires_at` is ''): what it is still to be told of
-- how the plan ended, typed at its prompt once it is ready, then cleared. Kept here so a daemon restart tells it once the
-- agent is resumed. NULL once told, and for a plan a call waited on.
ALTER TABLE plans ADD COLUMN untold TEXT;
