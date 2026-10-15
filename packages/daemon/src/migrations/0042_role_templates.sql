-- Role templates: a zone's prompt template for a role, as the user saved it. A role with no row uses its seed,
-- the repo's worker prompt or the app's own, read when it is used; so resetting one deletes its row.
CREATE TABLE role_templates (
  zone_id TEXT NOT NULL REFERENCES zones (id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  body TEXT NOT NULL,
  edited_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (zone_id, role)
);

-- A reviewer's detached checkout: the branch it reviews and the commit it checked out, NULL for any other
-- agent. Its own `branch` is ''.
ALTER TABLE agents ADD COLUMN reviews_branch TEXT;
ALTER TABLE agents ADD COLUMN reviews_head TEXT;

-- Every review of a branch a reviewer was started for, kept after its tile goes: the commit it reviewed, the
-- reviewer while it is on the board, and, once it is deleted, a copy of the review it left (a file in the data dir), so
-- a follow-up reviewer gets its round, the previous review and its commit.
CREATE TABLE branch_reviews (
  id INTEGER PRIMARY KEY,
  repo_root TEXT NOT NULL,
  branch TEXT NOT NULL,
  head TEXT NOT NULL,
  session_id TEXT,
  review_path TEXT
);
CREATE INDEX branch_reviews_of ON branch_reviews (repo_root, branch);
