---
status: accepted
---
# Usage pacing: a usage reading from Claude's status line, the user's zone priorities, and a budget hold the Captain may place only when the user lets it

A plan's 5-hour and weekly allowances run out, and when they do every agent on the board stops at once. The Captain (ADR-0019) leads the whole board, so it is the one to see what is left and fit the work to it, by the user's priorities. The decisions are where the reading comes from, what the user sets, and what the Captain may do with it.

## The reading

- **From Claude's status line, never by asking.** Claude Code passes its status line command `rate_limits.five_hour` and `seven_day` (each a used percentage and a reset time) on stdin. The `--settings` agent-board gives each Claude agent adds a status line command that posts that input to the daemon's hook listener at `/usage`, with the agent's hook token, as its `SessionStart` command posts. Nothing polls a private endpoint, and nothing spends a token to read it.
- **The user's own status line still runs.** A status line in `--settings` replaces the one the user set, so the command runs the user's own (from their settings) after posting, on the same input: its line, and anything else it does, stay as they were.
- **A project's status line is left to Claude.** A repo's `.claude/settings{,.local}.json` status line is gated by Claude's workspace trust; copied into `--settings` it would run from trusted settings, before or without that trust. So an agent whose project (the folder it starts in, or its worktree's root) sets one gets no status line of ours: Claude runs the project's as it would, and that agent posts no reading. Another Claude agent's will.
- **One newest reading for the board.** The daemon keeps the newest in its database, so a restart shows the last one, stale by then. The input names no account, so there is one reading, not one per account; Codex passes none. A reading older than 15 minutes, or one whose window has reset since, is stale, and the daemon tells clients when it goes stale. The same reading again is written and told at most once a minute.
- **Read by** `agent-board usage` and the MCP `usage` tool (a read any agent may make), and shown on the board as a pill beside the creation toolbar: a small meter per window, when each resets and how old the reading is on hover, hatched when stale. Nothing shows before the first reading.

## The user's priorities

- **A priority per zone**, High, Normal or Low, on its tab (a chip with a menu), Normal until set (`zone.configure`, kept on undo).
- **Thresholds in Settings › Usage**, each a used percentage: at the 5-hour or weekly only-High threshold, zones that aren't High may have their starts held; at the 5-hour pause threshold, Low zones' idle agents may be paused. The thresholds speak in tiers rather than a ranked list, so the tab says where each zone stands.
- **Read by** `agent-board usage priorities` and the `usage` tool with `priorities`: the switch, the thresholds, and per zone its priority, its hold and what the thresholds allow there now (`usagePace`).

## The budget hold

- **Off by default.** The no-more-than-the-harness rule (ADR-0019) holds: the app never acts on usage by itself. The user's **Let the Captain pace work by usage**, under the thresholds, turns on what follows; while it is off the daemon refuses every hold, saying so.
- **The daemon enforces the thresholds, not the Captain's judgement.** `orchestrator.hold` (`usage hold <zone>`) and `orchestrator.usagePause` (`usage pause <ref>`) are refused unless the caller is the Captain (or the user's side), the switch is on, the reading is fresh, and the zone's priority is past the threshold for that action. The reason the thresholds give ("5h at 86%, zone low priority") is stored with the hold.
- **What a zone's hold holds.** No agent starts an agent in the zone (`orchestrator.spawn` is refused with the reason); the user's own starts are not held. A hand-off to an agent in the zone is held on its edge, as one whose conditions fail is (`held: …` on its rail token), checked again every minute and at once when the hold is lifted. A named hand-off (`handoff --to`) has no edge of the user's to wait on, so it is skipped, saying why, for its agent to hand off again later. Send still sends: it is the user's. A clock an agent made starts no fresh agent there (its run is skipped, saying why), as the agent itself could not; the user's own clocks go on. Waking or restarting an agent already in the zone is not held: the hold is on new agents, and an idle one is paced by a pause for usage instead.
- **A pause for usage** is a pause (ADR-0011's, between turns only, never mid-turn), with its reason kept on the agent (`Agent.hibernated.reason`). Only the Captain or the user starts it again: another agent's `wake`, `restart` and `send` are refused, a hand-off to it is held on its edge (`held: paused for usage, …`) until it wakes, and checked again at once when it does (a named one is skipped, saying why), and a clock an agent made skips its message to it.
- **Every hold says why, where the work is, with Override.** A held zone's tab chip says so, its menu gives the reason and Override (which lifts it, `orchestrator.release`); a tile paused for usage shows "held: …" above its footer with Override (which wakes it). The Captain's panel lists every hold under For you with the same Override, and the Captain is told to put each in its digest. The Captain releases its own holds too; no other agent may lift one, so a held zone's own lead can't release itself.
- **Nothing lifts a hold by itself.** When the window resets the reading goes stale or falls under the thresholds, and the Captain (or the user) releases it.

## Considered options

- **Polling the plan's usage endpoint.** Rejected: it is private, and asking it from the app is more than the harness does.
- **Reading the master's own status line file.** Rejected: one session's file, outside the app; every Claude agent the app starts can post its own.
- **A ranked list of zones with sliders in Settings.** Rejected by the user for a chip on each zone's tab: tiers read where the work is.
- **A hold the app places by itself at a threshold.** Rejected: the app never paces anything on its own; only the Captain, only once the user lets it.
- **Holding a start as an unstarted tile, launched on Override.** Rejected for now: a refused start tells the caller why at once, and an agent row without a session would be a new state everywhere a start is handled.
