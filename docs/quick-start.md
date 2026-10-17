# Quick start

Once agent-board is [installed](install.md), open it. A short first-run flow checks your tools and tours the board; **Help › Getting started** brings it back.

1. **Add a zone.** Open the board menu (top left) and choose **Add a zone**, or press `Z` and drag one out. Pick a GitHub repo, a Linear team or a recent folder, or start with a group and bind it later.
2. **Start an agent.** Click **New agent** in the zone's tab, choose Claude or Codex, write the task and press **Start**. agent-board makes a worktree and a branch for it, and a tile appears with its live state. **Shell** (`` ` ``) puts a plain shell where you drop it.
3. **Answer it.** When it needs you, the orange **Needs you** pill counts it: answer from the popover, or double-click the tile for its session window.
4. **Connect your trackers.** GitHub needs only `gh auth login`. Linear needs a personal API key, which agent-board keeps in the macOS Keychain. Start an agent from an issue and its branch is named after it.
5. **Pick up sessions started elsewhere.** Turn on **Global hooks** in onboarding (Help › Getting started), and a `claude` or `codex` started in any terminal shows up as a tile you can resume inside agent-board.

Quit the app and open it again: every agent and shell is still running, because a background daemon owns them.

For every feature see the [tour](tour.md); if something goes wrong, [troubleshooting](troubleshooting.md) has the common causes.
