-- backward-safe: it only adds nullable columns, which an older daemon never reads.
-- Who last renamed the agent's tile and who last set what it is for, for its hover card's history: each a JSON
-- object {"by": name or null, "at": ISO time, "from": the old value or null}, `by` null for the agent itself. Null
-- until the first change after this migration.
ALTER TABLE agents ADD COLUMN renamed TEXT;
ALTER TABLE agents ADD COLUMN described TEXT;
