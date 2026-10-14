-- Zone-less agents and group zones. An unbound zone is a group, which may hold a default repo: a repo's root, or
-- a folder in one, that agents started in it without a repo of their own are cut from. NULL for none, and for every
-- bound zone. Existing zones keep their binding as they are.
ALTER TABLE zones ADD COLUMN default_repo TEXT CHECK (default_repo IS NULL OR repo_root IS NULL);

-- The model an agent was started with (its harness's `--model`/`-m`), so a resume or a scheduled relaunch keeps it;
-- NULL for the harness's own default.
ALTER TABLE agents ADD COLUMN model TEXT;

-- The role an agent was started in (`AGENT_ROLES`), or NULL for none.
ALTER TABLE agents ADD COLUMN role TEXT;
