-- Zone sources: a zone can be made from a GitHub repo, which the daemon clones for it.
-- While it clones, the zone is unbound and names the repo (`owner/repo`) and the folder it clones into. If the clone
-- fails, is cancelled or is cut short by the daemon going away, what it cloned goes: the folder itself only if the
-- daemon made it (clone_made_folder), and its owner's folder only if the daemon made that too and it is left empty
-- (clone_made_owner). All are NULL once the zone is bound to the clone, and for every other zone.
ALTER TABLE zones ADD COLUMN clone_repo TEXT;
ALTER TABLE zones ADD COLUMN clone_path TEXT;
ALTER TABLE zones ADD COLUMN clone_made_folder INTEGER;
ALTER TABLE zones ADD COLUMN clone_made_owner INTEGER;

-- Folders zones were made for, so Add zone can offer them again: a repo's root or a folder in it, with when it was
-- last used. Kept after its zone goes.
CREATE TABLE recent_folders (
  path TEXT PRIMARY KEY,
  used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO recent_folders (path, used_at)
  SELECT path, max(created_at) FROM (
    SELECT CASE WHEN folder = '' THEN repo_root ELSE repo_root || '/' || folder END AS path, created_at
    FROM zones WHERE repo_root IS NOT NULL
  ) GROUP BY path;
