# Changelog

## v0.6.0 (2026-10-23)

- A sturdier, faster release: retries for flaky e2e and visual tests, and reuse of a green main run
- Visual shots that show agent notes take the zone-tinted tab, and the expanded-crew shot waits for its zone
- The expanded-crew baseline shows the zone at its grown size
- An agent note's tab is a tint of its zone's colour, neutral when loose
- The on-command robot shows on an expanded tile too, from one shared component
- Release blockers: shape stroke tokens are allowed, agent-state baselines regenerated, changelog escapes \<
- Class and Interface shapes have name, attributes and methods sections, typed in one by one and grown to fit
- The zones pill brings its current zone back only when the window is resized, so it no longer snaps back while browsed
- Connectors take a class diagram's ends, a dash, a label at each end, and a Relation picker
- A built-in board master: ⌘⇧M panel and pinned tile that routes work to zone orchestrators
- README screenshots and feature list show the week's work
- Agent notes grow to show all their text, and arrange spaces lanes for them
- A zone grown round its crew's old places shrinks back to its saved size, and the arranged-crew shot fits once the crew holds still
- Continue on credits for a rate-limited agent: tile menu, pill button, agent-board continue and MCP continue_on_credits
- Pause an idle agent (hibernate) and wake it by Wake, a message or a hand-off
- Agent-note tethers and issue-card lines route round other tiles, like arrows
- The Ask Claude spec measures the shapes as drawn, grown to fit their text
- Agents show Markdown and HTML documents as a Doc tab and a board card; the user's edits write the file and tell the agent
- OSC 8 hyperlinks in the terminal open as other links do
- Drop three exports nothing else uses, so knip passes on main
- Schedules are clocks on the board that message an agent or start a fresh one
- Arrows and edge-rules baselines show routed lines and the new style bar
- The orchestrator ADR keeps \<branch> in code, so markdownlint passes
- Test branch names are neutral, so the public release check passes
- Arrange lays a zone out in lanes, prints a zone map, and can arrange by itself
- Expanding a loose tile pushes its neighbours as blocks, as in a zone
- A shape grows to fit its text, with align, font size and mono
- Agents write their own sidebar: PR, crew and hand-off doc records, guesses as the fallback
- Elbow and curved edges route round the tiles between their ends
- An orchestrator in a dirty or off-branch main checkout warns in New agent and on its tile
- Tiles show when an agent waits on a background command, instead of looking idle
- The chat-view e2e takes the tile back expanded when its session window closes
- A board change with nothing left still sets the nodes, so a Shift-click on a zone's body deselects it again
- The Tidy-with-an-expanded-tile e2e fits the view before it measures the tiles
- Restore the review chip on an implementer's tile, lost to a duplicated folded chip
- e2e waits for a start to finish only where it reads the agent, so the starting-tile and trackers specs pass
- A View popover in the zoom bar, a third crew look (Off) and ⇧C to cycle it
- Drop the unused isQuestionNode export, so knip passes on main
- A queued answer never types into a dialog, and a mid-turn Enter is confirmed at the turn's end
- Terminal / Chat switch in the pane strip, in the expanded tile and the session window
- The web tab's dev-server dot uses a font-size token, so the tokens test passes on main
- Agents can put a question on the board as a card beside their tile
- A new web tab opens blank with its address bar focused, listing local dev servers
- A new agent's tile is on the board at once, showing its start's steps
- Expanding a tile pushes what is right of it right and the rows below it down
- Needs you lists what agents explicitly flag, and crew flags go to their orchestrator
- ⌘-click links in the terminal view: web tab, ⌘⇧-click the browser, wrapped URLs
- New agent in a group has a Repo field; Orchestrator is a role with a Checkout row
- Tiles say what the agent does, not its last message; orchestrators set their crew's status
- Double-click on a tile's name opens it; a slow click on a selected tile's name renames
- Hand-offs confirm their turn started, press Enter again, and show one never sent
- Zones pill and dock share the bottom bar and both scroll
- Agent notes are a dashed card under a NOTE tab
- A click through a maximised window only minimises it; closing it restores an expanded tile
- Retry a failed worktree removal and stop the agent's whole process group
- Board pan keeps its momentum over terminals and other scrollable surfaces
- Friendly errors for partial Linear and GitHub answers, and the Linear Add zone screenshot back
- Reveal a session's folder in Finder instead of opening it

## v0.5.3 (2026-10-19)

- Switch to FSL-1.1-ALv2 and add a contributor licence agreement
- The social preview shows a mini board: agents in three states, a hand-off and a note

## v0.5.2 (2026-10-17)

- A shorter README: a visual front page, with the full tour, install notes, quick start, FAQ, troubleshooting and how it works under docs/
- sharp 0.34.5 → 0.35.5, fixing three high-severity advisories in its bundled image libraries
- sprintf-js is no longer pulled in by the build tooling (global-agent pinned to 4.1.3)
- Neutral wording throughout the docs and changelog
- THIRD_PARTY.md lists the bundled fonts and their licences
- The app's package.json carries the release version
- Each release gets a GitHub Release with its notes

## v0.5.1 (2026-10-16)

- quitAndWait lives in its own module; popover-keys waits for focus and retries Escape until the popover closes
- One key registry, the Extended keyboard shortcuts setting, and the ? / ⌘/ cheat sheet
- A setting for Claude's context compact window, off by default
- Give each Vitest project its own groupOrder; board-mcp test waits for the progress update
- Five load-only flakes wait on the state they act on (rotate, board-scroll, tab-moves, tile-chip-overflow, pull-requests)
- pnpm package installs the app; pnpm update:app updates a public checkout
- Keyboard conflict fixes: Ctrl+I and Ctrl+- stay the terminal's off macOS, no app reload or board close by accident, no single keys inside popovers
- Theme picker behind a Theme… popover; pick a family and the mode picks its light or dark theme
- daemon.log says how each agent's session ended
- Link a reviewer to the agent whose branch it reviews
- The status-set e2e expects a waiting tile's last message, not its status line
- A new agent shows starting, not idle, until its first turn begins

## v0.5.0 (2026-10-16)

- agent-board restart --fresh starts a new conversation in an ended agent's own tile
- new --no-template sends exactly the orchestrator's prompt, and new says which role template it applied
- A finished tile drops its stale progress line
- Arrow shaping: handles near the pointer, ends moved onto other objects, a bow handle on curves
- Arrange's cluster note is an agent note saying where the work stands, not the prompt
- Ask Claude about a selection: an agent reviews the picture and diagram, and its answer lands beside it with suggested edits
- Closed agents fold to chips on the board
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
- Linked agents as one rail, the latest document riding it
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
- Session windows lay tabs out in panes, each with its own tab strip
- Tiles resize, and a long task never pushes the branch or footer off
- One pass-through helper for the main-process IPC handlers, and a test that pins the channel set
- Remove dead paths and unused options; add a CLI ↔ MCP parity test
- Shell tabs close (×, middle-click, ⌘W), and Chat works when tabs exist
- Agents hand off explicitly over their edges, and orchestrators can wire their crew with edges
- Drag tabs and panes between session windows and the board, and a shell tile onto an agent
- Shell tiles get tabs too, so every session window works the same way
- Each staged public release's README describes only what that release contains
- Any window showing an agent's own pane marks its ask seen: one hook for ‹ ›, restored windows, app focus and shell tabs
- Refresh the README screenshots; add an orchestrator crew frame and an agent's shell tab
- Shell tabs and splits inside an agent's session window, and a shells chip on its tile
- Tests run with a scrubbed git env and fail if this checkout's core config changes; check:pr catches bare ticket IDs
- Text boxes resize from any edge or corner, with a font size control
- A click on onboarding's Back to setup pill no longer minimises the sign-in window first (a regression broke the first-run e2e)
- Opening a needs-you session marks it seen until it asks again
- The session window fills the board, and a size you choose scales with the screen
- Orchestrator UI: a per-zone switch (on by default), crew frames or from-chips, and an Activity tab
- A click on the board outside a session window minimises it
- Tile hover row is Expand · Pop out · ⋯ again, Delete in ⋯; e2e for ⌫ and the hover row
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
- Release pipeline hardening: pre-rename leak check, binary scan, ID spellings, and a leaner release

## v0.2.0 (2026-10-14)

- The agent-board CLI and a stdio MCP: every session on the board knows its zone, tiles and edges

## v0.1.0 (2026-10-14)

- Initial public release.
