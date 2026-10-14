-- Resuming an external session in agent-board adopts it as an agent. One resumed in its own folder works in
-- the user's checkout (or a folder outside git), which agent-board did not make: owns_worktree is 0 for it, so deleting
-- the agent only takes it off the board, never removing that worktree or its branch. Every other agent owns its own.
ALTER TABLE agents ADD COLUMN owns_worktree INTEGER NOT NULL DEFAULT 1 CHECK (owns_worktree IN (0, 1));
