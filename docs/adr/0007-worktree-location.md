---
status: accepted
---
# Agent worktrees live outside the repo

Each agent's git worktree is created at `~/.agent-board/worktrees/<repo-name>-<repo-hash>/<branch>`, not inside the repo. This keeps users' repos free of nested checkouts (no `.gitignore` edits, no tools or file watchers indexing every worktree twice), and lets several zones on one repo share a single worktree root. The short hash of the repo's absolute path avoids collisions between repos with the same name. Branch names come from the linked issue when there is one (`acme-12-…`, `gh-34-…`).

## Amendments

**2026-10-09**:

- With no linked issue, the branch is the agent's name as a slug (at most 40 characters) plus 6 random hex digits,
  e.g. `fix-the-flaky-tests-3fa2c1`.
- `<repo-hash>` is the first 8 hex digits of the SHA-256 of the repo's real (symlink-free) path.
- `$AGENT_BOARD_WORKTREES_DIR` overrides the root, for tests.
- Deleting an agent removes its worktree and branch. It asks first if that would lose work: uncommitted or untracked
  changes, commits on a detached HEAD that no branch has, or commits on its branch that no other branch or
  remote-tracking branch has. The app also asks before deleting an agent that is still running.

**2026-10-09**:

- An agent started from an issue gets the tracker's branch name for it: the lowercase issue ID plus the title as a slug,
  cut at a word boundary to at most 40 characters, e.g. `acme-12-spawn-agents-in-a-pty`. If that branch already exists
  (a second agent on the same issue), it gets `-2`, `-3`… instead of a random suffix, so the name still starts with the
  issue ID that links PRs back to the issue.
- Linking an existing agent to an issue never renames its branch.

**2026-10-09**:

- A GitHub issue's branch is `gh-` plus its number plus the title as a slug, with the same cut and `-2` suffixes,
  e.g. `gh-34-fix-the-login-redirect`. The repo is left out: a zone has one repo, and the issue's own ID
  (`owner/repo#34`) is on the agent's tile.

**2026-10-11**:

- A repo the daemon clones for a zone made from GitHub (a **managed clone**) goes to `~/.agent-board/repos/<owner>/<repo>`,
  beside the worktrees, not in a folder of the user's. `$AGENT_BOARD_REPOS_DIR` overrides the root, for tests. A clone
  that fails or is cancelled leaves nothing there.

**2026-10-11**:

- An agent can start from a repo it is given rather than its zone's: one picked in the repo picker (a repo, or a folder
  in one, which it then starts in), a group's default repo, or a new **scratch repo** the daemon makes for it, with an
  empty first commit as a new project gets. A scratch repo goes in `~/.agent-board/scratch` (`$AGENT_BOARD_SCRATCH_DIR`
  overrides the root, for tests), in a folder named by the agent's name as a slug, with `-2`, `-3`… if that is taken. A
  spawn that fails removes the scratch repo it made. Its worktree goes where every agent's does.
- The worktree can be cut from a named base branch of the repo instead of its HEAD.
- A branch name can be given: the repo picker prefills `agent/<agent name>`. It must be a name git accepts and one the
  repo doesn't have yet; the daemon refuses it otherwise rather than adding a suffix. Without one, the rules above hold.

**2026-10-11**:

- Resuming an external session in agent-board adopts it as an agent. By default it carries on in its own folder: the
  user's checkout (often the repo's main checkout, which the confirmation warns of), a linked worktree, or a folder
  outside git. That is the one agent worktree outside the worktree root, and the agent doesn't own it: deleting the
  agent takes it off the board and leaves the folder, its changes and its branch alone. Outside git, or on a detached
  HEAD, it has no branch (''): it has no pull requests, and a review is refused. A folder the user picks (when
  its own is gone) is the same.
- "Resume in a new worktree" (git only) makes a worktree at the usual place, on a new branch `<its branch>-resumed`
  (`-2`, `-3`… if taken) cut from the session's branch, in the same folder of it. A session on a detached HEAD has no
  branch: its new branch is `<its name as a slug>-resumed`, cut from the commit it is on. That agent owns its worktree as a
  spawned one does. Claude's transcript is copied to the new folder's project directory, where `claude --resume` looks.
