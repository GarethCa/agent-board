-- When an agent's own turn last ended with a final message (its Stop hook), beside that message (0022), so the board can
-- tell a manual edge out of it has something new to send since it last delivered. NULL before its first.
ALTER TABLE agents ADD COLUMN finished_at TEXT;
