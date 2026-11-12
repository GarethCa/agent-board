-- backward-safe: it only adds a table, which an older daemon never reads.
-- Which agents read a memory's entries, and when each last did: a row per entry and agent, written when an agent's
-- read returns that entry's whole text (a document listed by its title alone is not read). `name` is the agent's as it
-- read, so a row outlives the agent. As memory_entries' rows, none holds a foreign key: a removed entry put back keeps
-- its readers, and the daemon sweeps the rows of memories that are gone as it starts.
CREATE TABLE memory_reads (
  entry_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (entry_id, session_id)
);
CREATE INDEX memory_reads_item ON memory_reads (item_id);
