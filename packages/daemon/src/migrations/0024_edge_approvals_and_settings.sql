-- Gate and script conditions run only what the user approved: per edge, each command's approved fingerprint
-- (the command, the package.json script it names, the files they name), as a JSON object keyed by command. A
-- condition already on an edge starts unapproved, and holds until it is approved.
ALTER TABLE flow_edges ADD COLUMN approvals TEXT NOT NULL DEFAULT '{}';

-- The daemon's own settings, which it reads (unlike view_state): one JSON value per key.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
