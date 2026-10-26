---
status: accepted
---
# Agent worktrees live outside the repo

Each agent's git worktree is created at `~/.agent-board/worktrees/<repo-name>-<repo-hash>/<branch>`, not inside the repo. This keeps users' repos free of nested checkouts (no `.gitignore` edits, no tools or file watchers indexing every worktree twice), and lets several zones on one repo share a single worktree root. The short hash of the repo's absolute path avoids collisions between repos with the same name. Branch names come from the linked issue when there is one (`acme-12-…`, `gh-34-…`).

## Amendments

**Update**:

- With no linked issue, the branch is the agent's name as a slug (at most 40 characters) plus 6 random hex digits,
  e.g. `fix-the-flaky-tests-3fa2c1`.
- `<repo-hash>` is the first 8 hex digits of the SHA-256 of the repo's real (symlink-free) path.
- `$AGENT_BOARD_WORKTREES_DIR` overrides the root, for tests.
- Deleting an agent removes its worktree and branch. It asks first if that would lose work: uncommitted or untracked
  changes, commits on a detached HEAD that no branch has, or commits on its branch that no other branch or
  remote-tracking branch has. The app also asks before deleting an agent that is still running.

**Update**:

- An agent started from an issue gets the tracker's branch name for it: the lowercase issue ID plus the title as a slug,
  cut at a word boundary to at most 40 characters, e.g. `acme-12-spawn-agents-in-a-pty`. If that branch already exists
  (a second agent on the same issue), it gets `-2`, `-3`… instead of a random suffix, so the name still starts with the
  issue ID that links PRs back to the issue.
- Linking an existing agent to an issue never renames its branch.

**Update**:

- A GitHub issue's branch is `gh-` plus its number plus the title as a slug, with the same cut and `-2` suffixes,
  e.g. `gh-34-fix-the-login-redirect`. The repo is left out: a zone has one repo, and the issue's own ID
  (`owner/repo#34`) is on the agent's tile.

**Update**:

- A repo the daemon clones for a zone made from GitHub (a **managed clone**) goes to `~/.agent-board/repos/<owner>/<repo>`,
  beside the worktrees, not in a folder of the user's. `$AGENT_BOARD_REPOS_DIR` overrides the root, for tests. A clone
  that fails or is cancelled leaves nothing there.

**Update**:

- An agent can start from a repo it is given rather than its zone's: one picked in New agent's Repo field (a repo, or a folder
  in one, which it then starts in), a group's default repo, or a new **scratch repo** the daemon makes for it, with an
  empty first commit as a new project gets. A scratch repo goes in `~/.agent-board/scratch` (`$AGENT_BOARD_SCRATCH_DIR`
  overrides the root, for tests), in a folder named by the agent's name as a slug, with `-2`, `-3`… if that is taken. A
  spawn that fails removes the scratch repo it made. Its worktree goes where every agent's does.
- The worktree can be cut from a named base branch of the repo instead of its HEAD.
- A branch name can be given: a typed branch is checked; left empty, the branch is made from the agent's name (`agent/<agent name>`). It must be a name git accepts and one the
  repo doesn't have yet; the daemon refuses it otherwise rather than adding a suffix. Without one, the rules above hold.

**Update**:

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

**Update**:

- A zone made from a GitHub repo can bind to a checkout the user already has instead of a managed clone: one the daemon
  knows (a zone's, a recent folder's), one the user points at with "Use my copy…" (the daemon checks that the folder is
  a git repo, or in one, whose `origin` is that repo), or one "Find my local copies" found. That search runs only when
  the user clicks it, one level deep in `~/code`, `~/src`, `~/Developer`, `~/projects` and `~/GitHub`.
- Nothing changes for the user's checkout: agents still work in their own worktrees under the worktree root, cut from
  it, as for any zone bound to a folder.

**New folders and new repos**:

- A repo with no commits yet (just made with `git init`) has no commit to cut a worktree from, and the app never makes
  one for the user. An agent started there gets a worktree at the usual place on a new branch with no commits either
  (`git worktree add --orphan`, git 2.42 and later), and owns it as any agent does. Where git is too old for that, it
  works in the repo's own checkout instead, owning no branch, as an orchestrator in the main checkout does (ADR-0011),
  and its tile says it isn't isolated; a branch asked for by name is refused there rather than dropped. Whether git can
  is read from `git --version`, never from its (translated) messages. A base branch, a reviewer, or a reviewer of an
  agent that has made no commit is refused, saying the repo has no commits yet. Once such a branch has commits, its
  work is all of it: its review compares it with the empty tree, as does the project-config check of an orchestrator's
  `--base` on it.
- A folder is outside git only when git says it is not in a repository and no `.git` is in it or above it. A repo git
  can't read (dubious ownership, a bare repo, a damaged `.git`) is refused with git's reason, never taken as a plain
  folder, whose agents would share the user's checkout.
- A folder outside git can be a zone: a group whose own folder it is. Its agents work in that folder itself, with no
  worktree or branch, as in a group's own folder (ADR-0011). A zone's **Make it a git repo** runs `git init` there on the
  user's click, with no commit, and binds the zone to it; its agents from then on get worktrees as above.
