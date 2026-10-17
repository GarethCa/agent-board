# Troubleshooting

**The Connect step says `claude` isn't found.** The daemon looks on your login shell's `PATH`. Check that `which claude` works in a fresh terminal, fix your shell profile if not, then click **Re-check**. `~/Library/Application Support/agent-board/daemon.log` says which `PATH` it adopted.

**An agent starts and then fails straight away.** Run `claude` in a terminal first: it must be logged in, and it may be waiting for you to trust the folder or accept its terms.

**Codex asks me to review hooks.** If a repo has Codex config of its own, agent-board explains it before it starts an agent there. This is Codex's hook trust, and it is expected.

**GitHub says it needs a login.** Run `gh auth status` and, if needed, `gh auth login`, then reopen Add zone.

**Linear rejects my key.** Make a new personal API key, with access to the teams you want, and paste it again. To remove a stored key: `security delete-generic-password -s agent-board -a linear`.

**A banner says the daemon is from an older build.** The daemon outlives the app by design, so after an upgrade it can be the old one. Click **Restart daemon**; it warns first if sessions are running, because restarting ends them.

**"Delete agent" stops short.** The agent's worktree has uncommitted changes, or its branch has commits no other branch has. Push or merge them, or confirm that you want them gone.

**Start over.** Quit the app, stop the daemon and delete its data directory, then `rm -rf ~/Library/Application\ Support/agent-board`. Agent worktrees stay under `~/.agent-board/worktrees/` because they may hold unpushed work.

Anything else: search the [issues](https://github.com/GarethCa/agent-board/issues), and when you open one, include the build from the window title.
