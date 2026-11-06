# Changelog

## v0.6.17 (2026-11-06)

- Steps, Memory and Queue in the toolbar's add menu, Classic and Simplified
- Sections of the agent sidebar fold, and stay as they were left
- The details strip listens only to its own crew, not every agent
- An agent expanded on the board shows its shelves, as its window does
- Simplified look: a fainter zone tint, no dots on the desk, the Captain as plain text, the Needs-you pill without orange
- A steps card's -> link opens from the card, Needs you and the agent's window
- Tooltips and hover cards mount on first hover or focus, not with every tile

## v0.6.16 (2026-11-06)

- Profile the slowest test files; tempRepo copies a template, and test runs share a Node compile cache
- An orchestrator's tile keeps its chips inside it, folding the rest into +N
- Sidebar, part 4: rail and peek, and Shelves replaces Simple
- An orchestrator can change a running agent's reasoning effort: set_effort and agent-board effort
- A resume after a restart says nothing, instead of a red 'Relaunched after a restart'
- Crew prefabs, slice 4: New agent's Crew, the crew library, one prompt box, right-click and ⌘K
- Sidebar, part 3: Made, Crew and Setup rebuilt, pins on the page, controls in the header
- Guard the menu template's accelerators and the terminal's keys from the board

## v0.6.15 (2026-11-06)

- Steps, part 4b: answering a steps card from Needs you and the agent's window
- Sidebar, part 2: shelves opening on the agent's own page
- Crew prefabs, slice 3: the flow editor, with its diagram, inspector and the flow in words
- After a failed full check, check:pr --recheck reruns only the failures and what the fix touched, reusing the rest
- Hide the gallery page's scrollbar so full-width gallery shots stop including its thumb
- Queues, part 4: hand a job to an idle agent, tickets on takers, drain, and the user's queue with Needs-you rows and a focus view
- The Simplified design uses Classic's colour palette
- Steps, part 3b: the quick ask on the tile, and Put on the board
- Claude's question tool shows as its questions in Needs you, never as a permission with only Allow
- Queues, part 3: the queue card on the board, folding to its ticket icon, with a peek to reorder and finish
- Crew prefabs, slice 2: the running crew, its loop and round count
- More board background options: fine and large dots, lines, isometric, paper, vignette, plain
- Review… opens the terminal; steady the inbox and panel e2e specs
- A zone can lay out its work in clusters: each ticket's tiles together, what needs you first
- Memories, part 2: the memory card on the board, folding to its brain icon, with a peek to search and edit
- Crew prefabs, slice 1: the .crew.json model, one app-wide library, prefab export and import, and new --prefab
- Steps, part 2: the steps card on the board
- The Captain's chat follows the app theme, and an agent's chat can be light
- Sidebar, part 1: agents write their own page from blocks, with curated icons and tones (CLI and MCP)
- Migration 0072 deletes the events on the reviewer edges it drops, and a guard checks every migration does the same
- Memories and queues: the model, the CLI and the MCP (no board UI yet)
- The crew outline holds exactly the orchestrator's crew in its zone, in parts round other tiles
- Light agent notes stand apart from agent tiles as clearly as in dark
- Steps, part 1: steps cards in the daemon, with the agent's steps commands
- Terminals draw with xterm's WebGL renderer, with a DOM fallback, a 12-context budget and a Settings switch
- Agents take a reasoning effort: at start, from Settings, and changed live between turns
- The Simplified Needs-you list in sections, with Accept changes and Problems, one row pattern
- Gates start with a one-second pre-flight on the merged tree and stop early when it or a quick check fails
- The Captain, and any agent a clock messages, is resumed after a restart
- Starting a reviewer no longer draws Send edges, and Send says how it went
- Clear the minimatch denial-of-service alert for tooling that can take minimatch 11
- A zone can lay out its work on status shelves: To do, Doing, Waiting, Done, with stacks and the lead pinned top-left
- Pasting an image into an agent's terminal gives the image to the agent
- A session window's ⋯ menu has Maximise, and a setting can open it maximised
- Agent notes carry a small robot icon, so they stand apart from people's notes
- A first message to a Codex agent started with no task is held until Codex is up
- A Dock setting: show everything, only what you pin, or off
- Trim fixed test costs: one scene per theme for the chat shots, a start-limit override
- The board menu opens with only Zones expanded and remembers each section
- Many-agents perf spike: panes rebuilt on return and every agent change redrawing every tile; benchmark, findings, plan, two measured fixes

## v0.6.14 (2026-11-04)

- check-pr's new comments use wording the release leak check accepts
- the scanner list tests pass in the release, which drops the release tooling
- check-pr imports the release config by a non-literal path, so the release's knip passes
- Flake sweep: a zone tab at the edge of fitting no longer crashes the renderer, and the tests that kept needing retries wait for what they need
- A notification click never opens a second window
- Pacing by usage is removed; an audit lists other bloat
- The Codex interrupt handoff test no longer depends on hook start-up speed
- Markdown in an expanded tile selects and copies, and only the Edit button opens the editor
- A release reuses a green stamp across a small, safe follow-up commit
- The Captain's panel offers Resume or Wake for a Captain a restart stopped or paused
- Screenshot tests run on several workers: visual.spec.ts split by surface
- Claude's permission prompts stay answerable in Needs you until settled, not only for 20 s
- check:pr picks suites by blast radius: desktop core skips the daemon suite
- The web tab's camera check accepts a machine with no camera
- The agent window's sidebar sits on the left
- Emoji take two columns in the terminal, so text after them lines up and links stay clickable
- check:pr runs the tests that scan the repo from a scanner list
- Resume tells agents a restart cut off mid-turn to carry on
- check:pr runs knip in stage 1

## v0.6.13 (2026-11-02)

- The Simplified agent window's header gives the name the room and shows its controls on hover or focus
- tickDelay stays module-private (knip on main)
- The docked pane runs full height over the minimap by default, and its bottom edge drags up
- The live Thinking timer ticks in tenths of a second
- Simplified agent notes use Classic's tab naming their agent, with no side stripe

## v0.6.12 (2026-11-02)

- The agent pane's sidebar is simpler, and a setting offers it outside the Simplified design
- Agent notes look clearly like notes, not agents, under the Simplified design
- Box select sits with Select and Hand in the Simplified toolbar, not the Draw menu
- A crew member at its prompt reads Working with its orchestrator, not Needs you
- Test gate speed spike: what the gate catches, where the time goes, and 3 processes workers under load
- Zones keep their colour under the Simplified design, and theme-pack colours really show
- Settings looks finished, and the board menu keeps a few quick settings
- The chat's live timer counts whole seconds and shows the precise value when the step ends
- The docked pane ends above the zoom bar and minimap, which stay put
- Arrange packs a zone from its top edge, leaving no empty band above
- Agent notes show the day as well as the time they were updated
- A ticket-like name in a test fails the unit tests, not the release

## v0.6.11 (2026-11-01)

- The permission test's pushed branch is not named like a ticket branch
- The Simplified design honours the chosen theme pack and accent
- Settings opens as an overlay when the main window is full screen
- Agent notes become cards with a linked byline, and stickies stay exactly as they are
- Permission prompts are answered in the pane, in plain English
- Tabs stay as capable as today, drawn as light, worded tabs

## v0.6.10 (2026-11-01)

- The ⌘K windows test's branch is not named like a ticket branch
- The inspector test measures the Work group once the window holds still
- "Since you last looked" shows what got done and what's up next
- Notifications look like macOS banners, with one "Notify me when" choice
- First run introduces the Captain and gets Claude ready in two steps (Simplified design)
- The usage popover shot masks its refill times in a fixed box
- Shell tiles, folded chips, expanded tiles and start tiles match the calm tile
- Questions and plans are answered in the pane, where you type
- The Timeline view shows the run as a rail, with a "Show the conversation as" setting
- Usage sits in the Simplified toolbar as numbers, with the bars a click away
- ⌘K lists open and minimised windows first under the Simplified design
- A project shows as a coloured dot and a well, and every zone feature is in its right-click and ⋯ menus
- The composer's extras live behind one + menu
- An agent's details become a short grouped inspector under the Simplified design

## v0.6.9 (2026-10-31)

- The Simplified board and docked-pane shots are retaken with the calm tile
- check:local gives the visual suite 20 minutes, now it runs over 100 shots
- The agent-message bubble uses the semibold weight token, and the token test knows its --sender variable
- The chat shows an agent's message as its own bubble, from the sender, never as the user's
- An agent's tile is a calm tile under the Simplified design, with its window controls always shown
- Needs you and the Captain open one docked pane, each on its own side
- An agent's window has one header and switches between Chat, Timeline and Terminal
- Messages another agent sends carry a sender mark, read back into the chat entry's from
- Settings can be searched, and ⌘K finds settings too
- The toolbar keeps today's islands, with fewer buttons in each
- Agents, shells and zones take their menus from one model
- New agent and new zone open as tidy sheets
- Every agent shows one of six statuses, as a glyph and a word
- Settings spec follows Simplified-only controls, and setClickOpens closes the Settings window it opened
- An empty board offers three starter cards under the Simplified design
- Sends to a busy orchestrator are queued, and any orchestrator may message the Captain
- Dialogs keep today's confirmations, drawn in the Simplified design's language
- Connections keep today's rails, restyled in the Simplified design
- One Show technical details switch adds the technical layer back under the Simplified design
- Settings is its own window, with a sidebar of seven collapsible groups
- The Captain is the orange Claude character in a pirate hat
- Flaky specs wait for the view to settle and for the ripple they watch; release PR tests get a timeout sized to their git work
- The app menu gets About, Settings… (⌘,) and Check for Updates…
- Board view settings are kept where every window hears them
- A Simplified design setting switches the whole app to the new look
- A send left typed but unsent says so, and orchestrators can send --submit or --clear the draft
- Agent and shell tile controls stay visible at rest
- Arrange gets masonry and treemap layouts, available by name
- Web tabs keep logins in one shared session, with private tabs and Clear browsing data

## v0.6.8 (2026-10-29)

- Arrange gets an opt-in wrap layout: lanes wrap their tiles onto new rows after 4
- The usage pill moves out of the toolbar into Settings, with an option to show it beside the zoom controls
- An unsent or undelivered flag hidden by the agent's own flag stands again once that flag is cleared or read away
- Messages queued for an agent not yet up survive a daemon shutdown, shown with Resend after the restart
- Flaky tests wait for what they need under load: stop-tree, clock layout, board menu, terminal focus, note size

## v0.6.7 (2026-10-29)

- The quiet-net tests wait up to 10 s for the net's log line, which a loaded full run can take more than 1 s to write
- The kept-terminal flag reads location only where there is one, so tests that import the terminal pane under node load again
- README screenshots show the zone priority chip and the chat's live states
- The chat shows Claude Code's live states, in a style the user picks: cards, timeline rail or status line
- Rendering deep dive: terminals are rebuilt as they come into view; a benchmark, ranked findings and a kept-terminal prototype
- An agent whose turn ended takes messages when Claude says another session needs input
- Every Claude launch waits for its session before anything is typed; a message left unsent flags the user
- wait takes a duration for --timeout, documents exit 3 on a timeout, and the MCP wait tool returns timedOut
- update:app restarts the daemon and resumes its sessions, and the app never renders another build's daemon (no more blank window)
- Time assertions pass under a 12-hour locale: pin doc-view's clock, let the e2e delivered note carry AM/PM
- A sent message shows in the chat at once, the transcript is pushed instead of polled, and a pasted block folds
- The Captain sees 5h and weekly usage, and paces work by the user's zone priorities (opt-in)
- A long message is pasted at an agent's prompt, so Claude keeps all of it; a resumed agent is shown to sit idle
- A zone can trust its folder, so new Claude agents there skip the trust screen
- An agent stays at its prompt when Claude compacts while idle, and a lost Stop no longer leaves it running

## v0.6.6 (2026-10-28)

- An agent may reply to an agent that messaged it, even outside its scope
- Agent notes keep a size the user gives them (drag or note edit --size) through arrange and restart
- Claude's trust screen flags the user with Trust folder, the first prompt types itself once Claude is up, and messages queue until then
- MIN_CHAT_HEIGHT stays module-private (knip on main)
- The README screenshot generator's fake claude picks its scenario by worktree folder
- Answer a permission prompt from the Captain's panel, and pin that a loose agent's prompts reach the inbox
- The Captain's panel no longer scrolls sideways, resizes and folds, and ends above the dock
- Keep Codex agents' first prompt off argv: typed once Codex's screen shows its composer up
- Place beside an expanded tile where it is drawn, arrange the crew's clocks on the top row, and lint a zone with an empty band as mostly empty
- The stacked-agents rail shot waits for the tiles, zone and rail line to hold still before it fits and shoots
- Arrange measures off-screen notes in a hidden element, a refused arrange keeps a size the user set, and Esc closes the board menu
- Promo shots for pitch A: a shared demo board, one recording spec per storyboard shot with a cue log, and a first rough cut
- Demo mode in the app hides dev chrome, scripts the camera, draws a cursor and grows hand-offs
- A new migration no longer hides behind Vitest's cache

## v0.6.5 (2026-10-26)

- Bump node-pty so each terminal stops leaking a PTY on macOS (fixes posix_spawnp failed)
- Pin the lane note test's crew lines so their turns ending can't rewrite the note mid-test
- Agents start in a new folder or a brand-new repo (no git, or no commits yet)
- Record the board offscreen at 60 fps and 2x into ffmpeg (promo capture spike)
- Arrange and the zone map use sizes the app measures: notes as tall as their text, things where they're drawn, unmeasured when no window is open
- Bump dev tooling: vitest 5.0.5, eslint 10.13, typescript-eslint 8.72, @types/node 26.6.5
- The gate drops agent-board's own FORCE_HYPERLINK with its marker
- SPINNER_FRAMES stays module-private (knip on main)
- The demo welcome test uses the leak rule's fake home paths
- Demo scenarios in the fake harness that look like Claude Code and Codex

## v0.6.4 (2026-10-25)

- SessionStart is a command hook, since Claude runs no http hook for it

## v0.6.3 (2026-10-24)

- Type the first prompt only on SessionStart or Send, show the trust-screen hint, flag a stalled one
- Spacing per zone (Compact / Normal / Roomy) from the zone tab's ▾, Roomy by default
- Keep Claude agents' first prompt off argv: typed at the prompt once the session is up
- Arrange the board: zones in rows a gap apart, loose tiles below, one undo
- agent-board doc --plan presents a plan from the shell; the decision comes back at the prompt
- Clickable links from Claude: a setting, on by default (FORCE_HYPERLINK)
- The colour picker shows each distinct colour once (alike slots fold into the first)
- Patch undici, fast-uri and zod in build tooling

## v0.6.2 (2026-10-24)

- Arrange lays lanes out in pixels: own widths, exact rail room, rows as tall as what they hold
- agent-board zone screenshot / MCP zone_screenshot: a PNG of a zone from a hidden window, terminals hidden, with a lo-fi style to compare
- Zone map lint sees gaps between lanes, far labels and a mostly empty zone
- keyboard spec waits for the saved windows before reloading
- Pasting Mermaid draws a diagram, a selection copies as Mermaid, and agents get diagram add and export
- A web tab says when its page asks for a passkey, and offers the page in your browser
- Bump electron to 44.9.3 (certificate advisory)

## v0.6.1 (2026-10-24)

- Arrange respects expanded tiles: lanes keep their own widths, new crew lands in its lane, turned items stay clear
- An agent's sidebar lists every document it showed, and an agent can pin a file, a link or a note there
- Plan card baselines show the Captain button, renamed from Master after they were taken
- Shapes, text and connectors use the theme's twelve colour slots, with tinted fills, Accent on Tile and # for a fixed colour
- Tethers route round a tile a tile gap from their note, at half the clearance where the whole doesn't fit
- The board master is the Captain
- Plans can be edited before approving (Approve with my edits), and a plan card on the board opens the decision
- A starting tile fits: name, current step and harness, the rest folded into +N
- An agent in a group with no repo runs in the group's own folder, outside git
- Agents draw and read diagrams: shape and connector tools, and the board read shows a shape's sections and a connector's relation
- A document card resizes by dragging its sides, and keeps its size through the slim bar
- A note added near an expanded agent tile lands beside it, not under it

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
