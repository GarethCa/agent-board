---
status: accepted
---
# Usage reading: the plan's usage from Claude's status line, shown and readable, never acted on by the app

A plan's 5-hour and weekly allowances run out, and when they do every agent on the board stops at once. The user and the agents can see what is left; the app only shows it. Fitting work to it is left to the user and to their agents, as the no-more-than-the-harness rule (ADR-0019) has it. The decision is where the reading comes from and who may read it.

## The reading

- **From Claude's status line, never by asking.** Claude Code passes its status line command `rate_limits.five_hour` and `seven_day` (each a used percentage and a reset time) on stdin. The `--settings` agent-board gives each Claude agent adds a status line command that posts that input to the daemon's hook listener at `/usage`, with the agent's hook token, as its `SessionStart` command posts. Nothing polls a private endpoint, and nothing spends a token to read it.
- **The user's own status line still runs.** A status line in `--settings` replaces the one the user set, so the command runs the user's own (from their settings) after posting, on the same input: its line, and anything else it does, stay as they were.
- **A project's status line is left to Claude.** A repo's `.claude/settings{,.local}.json` status line is gated by Claude's workspace trust; copied into `--settings` it would run from trusted settings, before or without that trust. So an agent whose project (the folder it starts in, or its worktree's root) sets one gets no status line of ours: Claude runs the project's as it would, and that agent posts no reading. Another Claude agent's will.
- **One newest reading for the board.** The daemon keeps the newest in its database, so a restart shows the last one, stale by then. The input names no account, so there is one reading, not one per account; Codex passes none. A reading older than 15 minutes, or one whose window has reset since, is stale, and the daemon tells clients when it goes stale. The same reading again is written and told at most once a minute.
- **Read by** `agent-board usage` and the MCP `usage` tool (a read any agent may make), and shown on the board as a pill beside the creation toolbar: a small meter per window, when each resets and how old the reading is on hover, hatched when stale. Nothing shows before the first reading.

## Considered options

- **Polling the plan's usage endpoint.** Rejected: it is private, and asking it from the app is more than the harness does.
- **Reading the master's own status line file.** Rejected: one session's file, outside the app; every Claude agent the app starts can post its own.
- **Pacing work by the reading.** Built (zone priorities, thresholds, a budget hold the Captain could place, a pause for usage) and then removed: it was more than the app needs, and each agent can pace itself.
