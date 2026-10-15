# Changelog

## v0.4.0 (2026-10-15)

- Gates test waits for the token line, not the echoed command's :end
- Public README and screenshots for v0.4.0
- Edges: Arrow-or-Hand-off on agent-to-agent drops (⌥ skips), Edge rules in four sections, bendable lines on any side, collapsing labels
- Governance loosened as reviewed: user-side callers orchestrate, peers steer, children may orchestrate (depth 3), draft PRs from agents
- Agents with no conversation start fresh on resume; Shift+Enter and Restart follow a harness run in the fallback shell
- The fake harness's tool timeout counts from the call, not the MCP server's start
- One e2e run at a time across the machine, fewer Playwright workers under load, and leftover test processes reaped
- A session window never reaches under the macOS traffic lights, windowed
- README screenshots space out agents so edges, arrowheads and the Edge rules panel read clearly
- Tile footers and New agent's chips stay inside their edges, with a +N fold
- Launch the harness by a resolved absolute path, so claude set up only in .zshrc is found
- Agents ask questions and present plans: one-click answers in the inbox, and a Plan tab with a locked-down HTML view
- Model and role when starting an agent: chip menus, zone role templates, detached reviewers and tile badges
- Every zone can be deleted, with ⌫, the context menu and its ⋯ menu, and undone
- Add zone uses your local copy (Use my copy…, Find my local copies) and gets a File browser tab
- Merge gate in the app: a Gate tab, Open PR and Merge in the window header, and Approve for others' PRs
- README screenshots for panes, the PR tab and the web tab; text for the pane model and dragging tabs between windows
- Drag tabs to, from and between pop-out windows on the pane model
- Web tab: a locked-down view of a local dev server or https page, as a tab in a pane
- Native PR tab: a pull request's description, checks, diffs and comments, with confirmed Approve and Merge
- Break-it minors: split minimum, the seen pill everywhere, long names, zone rename undo, one IPC listener, keyboard paths

## v0.3.0 (2026-10-14)

- Deleted agents' windows close, dead controls go, and Dissolve asks first and can be undone
- Session windows lay tabs out in panes, each with its own tab strip (cmux model)
- Tiles resize, and a long task never pushes the branch or footer off
- One pass-through helper for the main-process IPC handlers, and a test that pins the channel set
- Remove dead paths and unused options; add a CLI ↔ MCP parity test
- Shell tabs close (×, middle-click, ⌘W), and Chat works when tabs exist
- Agents hand off explicitly over their edges, and orchestrators can wire their crew with edges
- Drag tabs and panes between session windows and the board, and a shell tile onto an agent
- Shell tiles get tabs too, so every session window works the same way
- Each staged public release's README describes only what its snapshot contains
- Any window showing an agent's own pane marks its ask seen: one hook for ‹ ›, restored windows, app focus and shell tabs
- Refresh the README screenshots; add an orchestrator crew frame and an agent's shell tab
- Shell tabs and splits inside an agent's session window, and a shells chip on its tile
- Tests run with a scrubbed git env and fail if the dev repo's core config changes; check:pr catches bare ticket IDs
- Text boxes resize from any edge or corner, with a font size control
- A click on onboarding's Back to setup pill no longer minimises the sign-in window first (a regression broke the first-run e2e)
- Opening a needs-you session marks it seen until it asks again
- The session window fills the board, and a size you choose scales with the screen
- Orchestrator UI: a per-zone switch (on by default), crew frames or from-chips, and an Activity tab
- A click on the board outside a session window minimises it
- Tile hover row is Expand · Pop out · ⋯ again (BC2), Delete in ⋯; e2e for ⌫ and the hover row
- The session details strip opens collapsed
- 16 zone colours and a fill-opacity slider per zone
- Zones drag by their header or empty body, and the header always fits the zone
- Recorded Linear fixtures carry fake UUIDs only, and the recorder and leak check keep it that way
- A project zone only takes issues from its own project
- Orchestrator control API, phase 1: agent-board new, send, wait, read, close and interrupt, for agents allowed to orchestrate
- E2E runs three tests at once, plus the headless follow-ups from the #102 review
- Delete works on every session tile, with one combined confirmation for a multi-select
- The hover test waits for the tile to settle in its state before measuring its parts
- Tiles sit straight; a Rotate tool for board items; the repo picker keeps Start inside its card
- Release pipeline hardening: pre-rename leak check, binary scan, ID spellings, and a leaner public snapshot

## v0.2.0 (2026-10-14)

- The agent-board CLI and a stdio MCP: every session on the board knows its zone, tiles and edges

## v0.1.0 (2026-10-14)

- Initial public release.
