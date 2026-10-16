-- An agent that renames its branch (git branch -m), checks out another or detaches keeps the board right:
-- the daemon re-reads its worktree's HEAD. \`branch\` stays the branch the agent owns (the one closing it checks and
-- deletes); \`current_branch\` is the other branch its worktree is on after a checkout, NULL while it is on its own.
-- \`detached\` is 1 while HEAD is detached: the tile shows the last branch.
ALTER TABLE agents ADD COLUMN current_branch TEXT;
ALTER TABLE agents ADD COLUMN detached INTEGER NOT NULL DEFAULT 0;
