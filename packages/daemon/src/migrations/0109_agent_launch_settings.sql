-- backward-safe: it only adds a nullable column, which an older daemon never reads.
-- An agent's own launch settings (LaunchSettings as JSON): env vars and Claude --settings added to what the board
-- launches its harness with, on every start. Null for none. An older daemon launches it without them.
ALTER TABLE agents ADD COLUMN launch_settings TEXT;
