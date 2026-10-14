# Changelog

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
