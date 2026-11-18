---
status: accepted
---
# The daemon's own git runs no hooks

The daemon runs git in agents' worktrees and the repos they share: it makes worktrees, fetches, reads status, commits a new zone's first commit, merges a crew's makers and pushes pull requests. Git runs the repo's hooks for many of these. A hook can be a file an agent wrote: with an in-tree hooks path (husky's `.husky/_`), a `post-checkout` committed on an agent's branch runs as the board makes a worktree on it. The daemon would run it with no step from the user, outside the agent's permissions.

## Decision

- **Every git command the daemon runs has hooks off** (`-c core.hooksPath=/dev/null`, which a repo's config can't turn back on). A command that wants a hook asks for it by name (`runGit`'s `hooks` option). None does today.
- **fsmonitor is always off** (`-c core.fsmonitor=false`): it is a program named in the repo's config that git runs on every `status`, and the daemon's reads don't need it.
- **Filters stay on.** Git LFS fills in its files at checkout with a filter, not a hook, so a new worktree still has them. Its `post-checkout`, `post-commit` and `post-merge` hooks only mark lockable files read-only, which the board does without. Its `pre-push` upload is done explicitly before each push the board makes: when the pushed commit's tree tracks files with LFS and `git lfs` is installed, `git lfs push` runs first, and a failed upload stops the push.

## Consequences

- A repo's own hooks no longer run for the board's git: a `pre-push` check on Open pull request (the board's gate is its check), or a `post-checkout` that sets up a new worktree (copying an env file, installing dependencies). An agent that needs that set-up does it itself, in its worktree.
- Commands the user or an agent runs in a worktree are theirs, and run hooks as git always does.
