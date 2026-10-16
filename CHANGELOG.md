# Changelog

## v0.5.0 (2026-10-16)

- agent-board restart --fresh starts a new conversation in an ended agent's own tile
- new --no-template sends exactly the orchestrator's prompt, and new says which role template it applied
- A finished tile drops its stale progress line
- Arrow shaping: handles near the pointer, ends moved onto other objects, a bow handle on curves
- Arrange's cluster note is an agent note saying where the work stands, not the prompt
- Ask Claude about a selection: an agent reviews the picture and diagram, and its answer lands beside it with suggested edits
- Closed agents fold to chips on the board (CA3)
- ⌘K is a Spotlight-style switcher from any screen, a terminal too
- Crew events and a finished signal: watch, wait --until finished, status set --done
- A PR chip no longer shifts a tile's rows, and the dock stays between the zones pill and the zoom bar, scrolling when full
- Arrange makes no PR cards and leaves a rail's room between linked tiles
- The board follows the branch an agent's worktree is really on
- Make the public repo ready to go public: settings script, package metadata, CI proposal
- Agent notes: a board item of their own for what agents write, as a document or terminal card
- Refresh the theme-pack baselines for the Shape button
- A test stuck in a loop is killed and named, runs stop with their starter, and gate stages have time limits
- Thirteen theme packs, picked in Settings, every one at WCAG AA
- 42 diagram shapes, a shape picker under Shape (S), and / to insert one at the pointer
- Arrange keeps the grid, an implementer before its reviewer, ticket labels and edited stickies; moves make room
- Touching an open session marks its new ask seen, so the needs-you count drops
- A custom role carries a name (designer, researcher…) shown on its tile, with zone templates and the app's default roles
- Keep the Mac awake through a gate, and say when it slept; bound sync launches in tests
- An orchestrator restarts an ended agent in place (agent-board restart, MCP restart)
- Linked agents as one rail, the latest document riding it (CD4)
- Serve the board MCP to Claude agents from the daemon over HTTP, not a stdio process each
- Refresh the expanded-crew baseline now Open PR is gone
- An expanded tile keeps a crew in its frame, moving the crew as one, inside its grown zone
- Remove Open PR from the expanded tile and session window headers
- Vitest worker counts come from cores, load and process headroom
- Show or hide connections on the board: all, hand-offs only or none
- Box select: Shift+drag or the Box select tool (B) draws a marquee inside a zone instead of moving it
- An ended agent's tile says it ended in its pill, with Restart in its hover corner and menu
- A tile shows the PR its agent pushed to, even on another branch
- Tiles pushed clear of an expanded tile stay fixed to the board as it pans
- Orchestrators organise their zone: move tiles, groups, arrange the crew into clusters, signed notes
- Edges made without sides pick them from where their tiles are, and run side by side without crossing
- macOS line-editing keys work in terminal panes
- Tests and gates ignore an enclosing board's AGENT_BOARD_* variables
- The board menu's sections scroll when its zones run past the window
- Restarting, resuming and deleting an agent move out of createAgentHost into agent-lifecycle.ts
- Anchor the .agent-board/ ignore so knip passes in worktrees under ~/.agent-board/
- Starting an agent and launching its harness move out of createAgentHost into agent-spawns.ts
- How hooks become an agent's state moves out of createAgentHost into hook-states.ts
- Hand-off delivery moves out of createAgentHost into deliveries.ts
- The context menu and the board's keys move out of BoardView
- Expanded tiles and the session-window glue move out of BoardView into two hooks
- Board data and incoming pastes and drops move out of BoardView into two hooks

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
