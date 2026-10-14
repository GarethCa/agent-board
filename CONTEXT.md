# agent-board

A desktop app that shows coding-agent sessions (Claude Code, Codex, plain shells) as objects on an infinite board, so one window replaces a pile of terminals.

## Language

### The board

**Board**:
The single infinite canvas a user works on. Holds zones, tiles, board items, connectors and edges.
_Avoid_: canvas, workspace (cmux owns "workspace")

**Zone**:
A coloured region of the board, either bound to one local git repo, optionally scoped to a folder inside it, or a **group**, bound to none. Several zones may share one repo. An agent started in a bound zone works in its repo, but any tile can sit in any zone, or in none: where a tile sits is only where it is drawn. It is moved by dragging its tab or its bare body, its tiles and items with it, and its tab always fits inside it: the chips that don't fit fold into the tab's ⋯ menu. Shrinking a zone past its tiles moves only the tiles its edge cuts through, each the least distance into free space clear of the other tiles and items; a tile that still fits never moves, and the zone stops once a cut tile has nowhere to go.
_Avoid_: project area, group

**Repo zone** / **Folder zone**:
A zone bound to a whole repo, or to a sub-folder such as `apps/web`. In a folder zone the agent's worktree is still the whole repo but its working directory starts at the folder.

**Group** (unbound zone):
A zone with only a name and a colour, bound to no repo: what the Zone tool makes by default, drawn with a dashed outline and a neutral tab. It holds notes, shell tiles and agents of any repos, each agent keeping its own. It can start agents: in its **default repo** if it has one, else each from the **repo picker**. It can be bound later from its tab: **Open as repo** binds it to an existing repo, or to a folder in one; **Open as project** binds it to a new or empty folder, where the app runs `git init` and makes an empty first commit; either way it becomes a repo zone or a folder zone. It can be given a Linear team or a GitHub repo as its tracker without a repo. Any zone can be **unbound** again: it goes back to a group with no repo or default repo, keeping its tracker (taken away on its own from its tracker dialog), so its issue cards stay and still start agents, and its agents and shells carry on where they are.
_Avoid_: empty zone, logical zone

**Default repo**:
A group's optional repo, or folder in one, shown as a soft chip on its tab. An agent started in the group with no repo of its own is cut from it, with no picker, and a shell made in the group starts in it. It doesn't bind the group: agents dragged in keep their own repos.

**Repo picker**:
The popover on a new agent's tile that asks which repo to cut its worktree from, when no zone gives it one (dropped on bare board, in a group with no default repo, or started from an issue card with no repo where it is): a recent repo (the last used preselected), Browse… for any folder, or a **scratch repo**, then its base branch and a new branch name (`agent/new-agent-N`, the name the daemon offers), and a collapsed "Model · Role" row: harness, model and role. A repo an agent starts in from there becomes a recent folder.
_Avoid_: repo dialog, wizard

**Scratch repo**:
A new git repo the daemon makes for an agent with no repo to work in, with an empty first commit: a folder named from the agent's name as a slug (`-2`, `-3`… if taken) in the scratch folder, `~/.agent-board/scratch` (`$AGENT_BOARD_SCRATCH_DIR`). If the agent fails to start, it goes.

**Zone source**:
Where Add zone makes a new zone from, one tab each of its popover (opened by the **Zone tool**, `Z`, dragging out where the zone goes): **none**, a group, the tab it opens on; a **GitHub** repo gh can see (its local clone if the daemon knows one, else a **managed clone**), its tracker set to the repo's GitHub Issues; a **Linear** team, or one of its **projects** (named after the project), its tracker set to the team or the project, bound to a recent folder or left a group; or a **recent folder** a zone was made for before ("Browse…" there is the only way to the OS folder picker). Its name and colour are set at the foot of the popover. Nothing is imported: a zone starts empty, and its tracker's issues are picked one at a time from its tab.
_Avoid_: import

**Managed clone**:
A GitHub repo the daemon clones for a zone, with gh, into `~/.agent-board/repos/<owner>/<repo>` (`$AGENT_BOARD_REPOS_DIR`). While it clones the zone shows its progress and a Cancel on its tab, and starts no agent. If the clone fails, is cancelled, or is cut short by the daemon going away, its folder goes, and so does its zone, unless sessions were moved into it meanwhile: then it stays, unbound.

**Tile**:
The board object for one session. Rendered by the active representation. Every tile can be dragged into any zone or loose onto the board, and keeps the place it is dropped (kept by the daemon, relative to its zone); a new one takes the first free spot. Where it sits changes nothing about its session. An agent's or shell's name is the user's to change, in place: a double-click on it, the pencil beside it, F2 with the tile selected or its context menu. A shell split into panes can also label each pane, with the shell's name standing in without. Agents don't rename themselves (they set their **status**); renaming never touches the worktree, branch or session.
_Avoid_: card (cards are issue cards), node

**Expanded tile**:
A tile opened in place on the board: by a double-click (or Enter) when the **click setting** says Expand in place, else from its tile's hover Expand or its ⋯ menu. Still a board object, so it pans, zooms and drags (by its header) with the board, and is resized from any corner or edge, within a least and a greatest size; in a zone, not past the zone's padding. It opens at the size it was last let go at. A one-line header (name, state, branch, issue, pull requests; Maximise, Pop out, Delete, Collapse) over the session window's body: the details strip on the left and the live terminal, or a shell tile's panes, taking input. An external session's shows only its details. Several may be open at once, the last one clicked in front. It stays expanded until collapsed: Collapse returns it to its tile, as does Esc with the board focused (the one in front, then the next); a click elsewhere, on another tile or on another session's window leaves it be. The session keeps running. Its header's Delete deletes its agent or shell as the tile's ⋯ menu does, asking the same first (an external session's is Remove from board). Maximise opens its session window and Pop out its OS window, collapsing it, as a session is shown in one place at a time. Which tiles are expanded, their sizes, and which tile was dropped onto which, outlive a restart. Its zone grows to hold it, and what it would cover (tiles, items, zones) is pushed clear of it while it is open, live as it is resized, a zone's own tiles rearranged within it first (the zone growing further only if they don't fit); all of it eases back when it collapses: drawn there only, never saved, unless the user drags it (resizing it from its left or top moves it, which is saved). Several expanded tiles, and the zones grown round them, are kept apart too, in board reading order, the first staying put and each next going to the clear spot nearest it: never by which is in front, so bringing one forward moves nothing. An expanded tile being dragged moves nothing out of its way. A tile the user drops onto another, one of the two expanded, may overlap that one, and only that one (but a shell tile dropped on an agent's becomes its tab, **Moving a shell**): the two stay where they were seen (the one dropped onto keeps the place it was drawn at), each still kept clear of everything else. The pair ends when either tile moves any other way (dragged again, nudged, undone, tidied, moved from a menu), collapses, is expanded again or goes. While a tile is dragged or resized, everything starts from where it was drawn as it began, so starting one moves nothing; what a resize grows into makes way from there.
_Avoid_: card, session card (cards are issue cards), panel, inspector

**Tidy**:
Laying tiles out in neat rows, in board reading order (by rows, then left to right): a zone's, from its tab's Tidy button or ⋯ menu, keeping its width and fitting its height to them, round its notes and cards; or the tiles loose on the board, from the board's context menu, in a grid about square from the top-left of where they are, clear of zones and items. Unlike the room made round an expanded tile, it is saved, and one undo puts it back.
_Avoid_: auto-layout, sort

**Session window**:
The window that shows one session, or a shell tile's panes, over the board (or popped out into an OS window of its own): what a double-click on an agent's or shell tile opens by default. A single click only selects the tile. On the board it is resized from any edge or corner, within a least and a greatest size and inside the board, and Maximised and Restored from its header (or a double-click on empty header space); one global size and place is remembered across restarts, and a pop-out's OS window size is remembered too. Its header steps through the other sessions of the tile's zone, or the other loose ones for a tile in none, in board order (left to right, then top to bottom), with ‹ › and ⌘[ / ⌘], wrapping at the ends; the window swaps what it shows rather than closing. Its details strip opens collapsed to the icon rail in every session window, pop-out and expanded tile (⌘I, the rail's Show details or a drag out of the rail opens it; nothing carries open across windows), and is resized by dragging the handle on its border (at least about 200px, at most half the window; pulled below the least it collapses to the icon rail, ⌘I, and dragging out from the rail opens it again; double-click resets; arrow keys step it), one width remembered for every session window, pop-out and expanded tile, and shows the focused pane's **live folder**, where that pane's process is now (following `cd`, `~` for home, copyable, opening in Finder), beside an agent's fixed worktree and branch, with an "Outside its worktree" hint when it has left it.
_Avoid_: modal, dialog

**Seen**:
An agent whose session the user has opened (a session window, an expanded tile or a pop-out, or focused an open one) since it began its current ask: waiting for input or a permission prompt. A seen agent drops its needs-you look on its tile (no orange outline, a calm pill), is read in the inbox, and no longer counts towards the dock badge, the dock's needs state or the menu-bar dot. The daemon keeps it, so every window and restart agree. The next change of its state (it works, or a new permission prompt) clears it, and it needs the user again. Ended agents and the inbox's Dismiss are unaffected.
_Avoid_: acknowledged, read (an inbox item is shown read; the agent is seen)

**Click setting**:
What a double-click (or Enter) on a selected agent's or shell tile opens (a single click selects it): its **session window** (the default) or its **expanded tile**, picked in the board menu's Settings under Board. The tile's ⋯ menu offers the other one, once. An external session's tile, having no session window, always expands.

**Representation**:
A swappable way of drawing tiles and subagents. v1 ships only **Hybrid** (calm tile + subagent characters). **Character**, **Token** and **Plain tile** are post-v1.

**Character**:
The small robot figure that shows a subagent's state through pose and face. Bean body for Claude, block body for Codex.

**Issue card**:
A kind of board item: a tracker issue as it was when picked (its ID, title, state and link), put in a zone from its tab's issue picker. Until an agent works on its issue it offers to start one; an agent linked to its issue is drawn fed by it, along an **issue brief** edge.
_Avoid_: ticket

**Issue brief**:
The coloured flow edge, labelled "issue brief" with a trigger icon, from an issue card to each agent linked to its issue. Drawn by the board from the card and the agent's linked issue; never stored, selected or deleted on its own. Edges between agents share its look.

**Board item**:
A whiteboard object on the board that is not a session: a sticky note, a text item or a shape, and later kinds. It has a kind, a place, a size, a stacking order and data of its own kind's shape. Like a tile, it sits in a zone (and moves with it) or loose on the board, and dragging it in or out of a zone moves it into that zone or out onto the board. Kept by the daemon, so it outlives the app.
_Avoid_: node, widget, edge (an edge is a flow between agents)

**Sticky note**:
The first kind of board item: a coloured square of short markdown text (bold, italics, lists, https links) whose font shrinks to fit. Made by double-clicking bare board or a zone, the Sticky button, or `N`.
_Avoid_: note card, card (cards are issue cards)

**Image**:
A kind of board item: a PNG, JPEG, GIF or WebP, pasted from the clipboard or dropped on the board, at most 20 MB. Its bytes are kept by the daemon in the **image store** (files named by the SHA-256 of their bytes, outside SQLite); resizing keeps its aspect ratio unless Shift is held.
_Avoid_: picture, attachment

**Link card**:
A kind of board item made by pasting one https URL on the board. It shows the page's title, domain and favicon, fetched by the daemon in the background (best effort, no scripts run, 5 seconds at most; the bare URL shows meanwhile and if the fetch fails). For a Linear or GitHub URL that a zone's tracker covers it also shows the issue or pull request's state. Clicking it opens the URL in the browser.
_Avoid_: bookmark, embed

**Text item**:
A board item of free text with no background, in heading 1, heading 2 or body size, with bold, italics, alignment and a colour. As wide as its longest line while typed, until it is resized, when it keeps its width and wraps. Made with `T` (or the Text button), then a click. Removed if left empty.
_Avoid_: label, text box

**Shape**:
A board item that is a rectangle, rounded rectangle, ellipse or diamond, with a fill (or none), a stroke and centred text. Made with `S` (or the Shape button), then a drag to size it. Draws below tiles, so one can frame a group of agents without covering them.
_Avoid_: node, frame

**Connector**:
An annotation arrow or line between any two board objects: zones, tiles, sticky notes, text, shapes, images and link cards. A thin neutral line (straight, elbow or curved; an arrow, a dot or nothing at each end; a colour; an optional label in the middle) that explains the board and never carries or triggers anything. Made by dragging from a **connector handle**, it follows its two objects when they move, and is deleted with either. Kept by the daemon, in its own table.
_Avoid_: edge (an edge is a flow between agents), arrow, link (a link card is a board item), wire

**Connector handle**:
One of the four round dots, at the middle of each side of an object, that show while the pointer is over it or it is selected. Dragging one onto another object, or onto its handle, joins the two with a connector; dropping on empty board makes a new sticky note there and joins that; dropping anywhere else does nothing. A zone is joined by its tab or a handle, since dropping in its body makes a note in it. Handles are **round** and sit on the middle of a side. A **flow port**, from which an Edge is dragged, is a **square**, coloured, and only on agents' tiles, so a drag's origin tells the two gestures apart: round makes an annotation, square makes a flow. The two never share a gesture, and a connector never becomes an edge.
_Avoid_: port (that is the flow edge's square one), anchor

**Rotate handle**:
The round grip under a board item selected on its own, or under the box round a selection of several, that turns the item (each item, about its own centre) as it is dragged round; Shift snaps the angle to 15° steps. The angle, its **rotation**, is saved on the item, undoable, and put back straight by Reset rotation (the selection's menu, or ⇧R). Only the user turns things: tiles always sit straight, and nothing on the board is drawn at an angle by itself.
_Avoid_: tilt (the old automatic lean, gone), spin

**Selection**:
The board objects picked together, by click, Shift-click, a marquee dragged on empty board (or inside a zone with Shift held, since a plain drag there moves the zone), or select all. It moves,
aligns, restacks and is undone as one, inside one labelled box. Delete, copy and duplicate act on its board items and
connectors only (Delete also on a selected edge); a session in it is never copied or duplicated from there, but is deleted behind one combined question, listing what happens to each kind (items stay undoable, sessions don't). ⌫ never deletes a session while the keyboard belongs to its session window, its expanded tile or a dialog.
_Avoid_: group (nothing groups objects for good)

**Undo history**:
The board edits a window can take back and redo: making, changing, moving, resizing, restacking and deleting board items
and connectors, moving and resizing zones and tiles, and dissolving a group (undone, it is the same group again, with its tiles and notes back in it). Kept in that window's memory, at least 100 steps; it never
starts, stops or sends to a session.
_Avoid_: history (alone: a run history is a long-lived agent's)

**Alignment guide**:
A line drawn while dragging where an edge or centre of what is dragged meets one of something near it, which it snaps
to, as on Miro. Holding the command key drags without snapping, and **snap to grid** puts the corner on the desk's dots
instead.

**Theme**:
The app's whole look as one set of theme token values: its UI, the terminal's ANSI colours, how a sticky note's stored colour is drawn and the agent states' colours. v1 ships **Workbench** light (a dotted off-white desk, tinted zones, white tiles) and the dark **Warm graphite**. Which one shows is the **Appearance** setting.
_Avoid_: skin, style (a representation is a style of tile)

**Appearance**:
The setting, under Settings › Appearance, that picks the theme: **System** (the default) follows the OS's light or dark mode, live; picking a theme (v1: **Light** or **Dark**) overrides it. One per user, not per board, and every window follows it at once.
_Avoid_: dark mode (a mode of macOS), theme setting

**Theme token**:
A named value for one role in the look, such as `--state-waiting` or `--space-2`, defined only in `tokens.css`. A theme overrides tokens; nothing else writes a literal colour, spacing, radius, font, shadow or motion value (`docs/theme-tokens.md`).
_Avoid_: variable, design token

### Sessions and agents

**Session**:
One long-running process owned by the daemon and attached to a PTY: an agent or a plain shell. Outlives its window and the app.
_Avoid_: terminal (a terminal is a view of a session), process

**Agent**:
A session running a harness (`claude` or `codex`), with an optional model and **role** (implementer, reviewer or follow-up reviewer), in its own worktree (or, for an external session resumed in agent-board, in a folder of the user's that it doesn't own, which deleting it leaves alone). Its repo is the one it was started from (the repo picker's, else its zone's repo or default repo; for a resumed external session, its folder's repo, or the folder itself outside git, with no branch), and stays its own: its tile can sit in any zone or loose on the board, and then shows a repo chip when it is outside every zone of its repo. Deleting it, its pull requests and its linked issue all go by its own repo, never by the zone its tile sits in. One started with no task sits at its prompt, named `new-agent-N`.

**Agent tool** / **Shell tool**:
The toolbar's New agent (`A`) and Shell (`` ` ``): dragged off the toolbar onto the board, or armed with a click (or the key) and then a click on the board, they carry a ghost tile under the pointer, and the new tile lands where it is let go, in the zone under it or loose on the board. An agent dropped in a bound zone, or a group with a default repo, starts at once; anywhere else the repo picker opens on its tile.

**Harness**:
The agent CLI a session runs: `claude` or `codex`.
_Avoid_: provider, model, engine

**Shell session**:
A session running a plain shell with no harness. Each pane of a shell tile is one.

**Shell tile**:
A tile holding one or more shell sessions, laid out as panes in its window. It sits in a zone or loose on the board, like a sticky note, and dragging it in or out of a zone moves it into that zone or out onto the board. Made in a zone, its shells start in the zone's folder, or a group's default repo, else the home directory; made loose (the Shell tool), in the home directory. Its **folder chip** shows the folder its first live pane is in, following `cd` (`~` at home), and opens a new pane at home, in a recent folder or one browsed for. Moving it, binding or unbinding its zone, or a new pane elsewhere never moves its running shells. Its window has **tabs** as an agent's does, its own panes the first; its other tabs are never tiles. Closing its last pane removes it, unless it has other tabs, when the next becomes its first; the tile keeps its own folder, where its new tabs and panes start.

**Pane**:
One box of a session window (BH1, cmux-style), with its own strip of **tabs** and showing one of them: the window splits into panes side by side or one above the other (⌘D, ⇧⌘D, the strip's Split, or a tab dropped on a pane's edge), each new pane holding a new shell tab, and resized by dragging the divider between them. The pane with the keyboard is the focused one (its strip underlined, of several); ⌘⌥ and an arrow (Ctrl+Shift+Alt and an arrow off macOS) move the keyboard to the pane that way. A pane that loses its last tab closes. How a window's panes are laid out is kept with the daemon, per agent or shell tile, across restarts; a window that never kept one shows its tabs in one pane, its strip the window's own. A shell tile's own panes are split inside its tab, tmux-style: a shell session each, from the details' Split horizontally and Split vertically while its own tab shows (anywhere else they split the window, as ⌘D does) and its folder chip, each labelled in its header. A shell or agent's tab split inside itself before window panes is laid out as the window's panes as its window opens, each of its panes a tab of its own, where the tab was, no shell restarting.
_Avoid_: split (for the pane itself; a split is what divides two panes)

**Tab** (terminal tab):
One of the tabs in a **pane**'s strip of an agent's or a shell tile's session window, cmux-style: each shows one **surface**, the agent's own (a shell tile's own panes, named after the tile, in its window), one of its **shell tabs**, or another session shown there. A window starts with one pane, the agent's own tab first. **+** (⌘T) opens a shell tab in its pane where the agent started (in the tile's folder for a shell tile), at a folder browsed for, or running one of that folder's package scripts (named after it, such as `pnpm dev`), or shows another agent or shell tile there (**Show a session**); ⌘1–9 pick the focused pane's tabs (⌘9 the last), as ←/→ do in the strip. A tab drags along its strip, onto another pane's strip, or onto a pane's edge, splitting it there; the agent's own and another session's only within their window. Off macOS these are Ctrl+Shift+T, D, W and 1–9, Ctrl+Shift+Alt+D for ⇧⌘D: Ctrl's own keys (Ctrl+D ends input) stay the terminal's. The window-level tabs (Terminal, Review, Activity) are not these. A shell tab's shells are ordinary shell sessions its agent or shell tile owns: they keep running when the window closes, survive a restart (stopped by it, resumable), and end with the agent or tile when it is deleted. Closing a shell tab (its ×, shown on hover and on the tab showing, a middle-click, or ⌘W with it showing in the focused pane; Ctrl+Shift+W off macOS) ends its shells, asking first while one still runs, as deleting a shell tile does; closing a shell tile's own tab, which has a × while the tile has other tabs, ends its own panes, and its next tab becomes its own. Closing another session's tab only takes it out of the window. The agent's own tab has no close (⌘W there is left to the app), and an agent's own pane is ended only by Stop or Delete. A shell tile whose first tab loses its last pane keeps going while it has other tabs: the next becomes its first. A tab is never a tile on the board, but it can **move** to become one.
_Avoid_: window tab (Terminal, Review, Activity)

**Surface**:
What a **tab** shows: the window's own session (an agent's, or a shell tile's own panes), one of its shell tabs, or another agent's session or shell tile, shown there and still its own: it isn't moved, its identity doesn't change, it keeps running when its tab closes, and its tab goes when it does (deleted, or a tile becoming a tab). Seeing an agent's session there marks its ask seen, as its own window does. It is a second view of the same terminal: while its tab shows, the last window to resize it sets its size; a tab not showing never resizes it, nor marks its ask seen. PR and web surfaces come next.
_Avoid_: view, panel

**Moving a shell** (AT2):
Dragging a shell tab by its tab, or a pane of a split by its header, onto another session window's tab strip or body, or onto an agent's or shell tile, makes it one of that window's tabs: where it was let go on a pane's strip or at a pane's edge, else after the focused pane's others; onto bare board, a shell tile of its own where it is dropped, named as the tab was. A pane dropped back on its own window becomes a tab of its own there, unless it is let go over itself, which gives the drag up. A shell tile dragged onto an agent's tile, its expanded tile or its session window becomes one of its tabs, its own tabs coming too (dropped on any other tile, it overlaps that one as before). The agent's own tab never moves, nor a shell tile's first while it has other tabs. Moving never restarts anything: the shell's processes, output and folder go with it, and only its owner, or its place, changes, so it speaks for its new owner on the board at once (its `AGENT_BOARD_ZONE_ID` stays the zone it started in, as for a moved tile). A shell kept in another agent's worktree shows an amber "runs in impl-auth's worktree" tag in its new window. The window it lands in keeps the tab it shows, the keyboard goes to the board, and ⌘Z takes the move back (a pane back into its split as it was laid out, a tab back into the window pane it left while that pane is still there), ⇧⌘Z does it again. Moving a tab between a window's own panes changes only its layout, and isn't undone. Connectors on a tile that becomes a tab are kept, unseen, and show again if it comes back. A moved shell keeps its name, so a window or zone may hold two of a name until one is renamed; nothing is renamed by a move, so an undo puts back exactly what was. A shell tile expanded when it becomes a tab comes back expanded on undo. A move into an agent or shell tile being deleted is refused. Not from or to a pop-out yet.
_Avoid_: adopt, transfer

**Shells chip**:
The chip in an agent tile's footer when it has shell tabs: "2 shells", one dot per shell (at most five, then "+N"), green running a command, grey idle, red when its last command failed (as bash and zsh report, through the shell integration the daemon adds) or the shell exited non-zero. Hovering it lists them, with the ports a running one listens on or the exit status, and "+ New shell in this worktree"; a row opens the session window on that shell's tab, over Review or Activity too. Deleting the agent says its running shells end with it. A shell never changes the agent's state or joins Needs you.

**Subagent**:
An agent spawned by another agent inside the same harness process (e.g. Claude's Agent tool). Has no PTY of its own; shown as a character on its parent's tile.

**Transcript**:
The file a harness writes its conversation to as it goes: Claude's JSONL under `~/.claude/projects`, Codex's rollout under `~/.codex/sessions`. Its format is the harness's own and changes without notice; agent-board only reads it.
_Avoid_: log, history

**Chat view**:
An agent's session window showing its conversation read from its transcript, instead of its terminal: its messages (the agent's as Markdown, never loading anything), each run of tool calls between two messages folded into one row that opens to a line per call (the newest open while it runs; Expand all and Collapse all for every one), its subagents' messages, and a message box at its foot. A transcript the chat can't read leaves the terminal only. The chat is the agent's own pane's: picked while a shell tab shows, it brings the agent's own tab forward, and its shell tabs stay terminals, with no message box under them.
_Avoid_: chat mode, TUI view

**Ephemeral agent**:
An agent that runs one task, leaves an artifact (e.g. a review doc) and terminates.

**Long-lived agent**:
An agent re-run by a schedule or webhook trigger.

**Schedule**:
A long-lived agent's cron trigger: a five-field cron expression in the daemon's local time (which follows the system's time zone) and the prompt each run sends. One per agent. Its tile carries a clock badge with the next run. A schedule outlives its agent's session: a run relaunches an ended agent.

**Agent state**:
One of: `running`, `thinking`, `waiting` (for input), `needs-permission`, `idle`, `rate-limited`, `failed`, `done`, `scheduled`, `stopped-by-restart`, `handing-off` (delivering along its edges, a **hand-off**). `done` means the agent's session has ended, or the user stopped it; `failed` that it crashed or was killed otherwise, or that a turn failed. `scheduled` means a long-lived agent sits at its prompt waiting for its next run, not for you; it is never in the needs-you inbox. A scheduled agent whose last message asks you something is `waiting` instead. `stopped-by-restart` is the state an agent is **stopped by restart** in.

**Stopped by restart**:
A session whose process ended because the daemon went away under it (a crash, a shutdown, the machine restarting), not because it exited or the user stopped it. Its tile shows its last output and a **Resume** button, and a banner counts them all, with **Resume all**: nothing starts again, and no tokens are spent, until the user picks. Resuming carries on an agent's conversation (`claude --resume`, `codex resume`), or starts a new shell in a pane's last folder under its old output, marked restored. An agent with a schedule is never stopped by restart: its schedule relaunches it.
_Avoid_: crashed, failed (those are the session's own doing)

**Status**:
What an agent says it is doing now, set from its own session with `agent-board status set` or the board MCP's `set_status`: one line, at most 200 characters, and how far through it is (0-100) if it says. Its tile shows it in place of its task until it sets another; the last writer wins (ADR-0010).
_Avoid_: description (that is the task it was given). Its line of text is its **summary**.

**Board CLI** / **board MCP**:
`agent-board`, the command line every session the app starts finds on its PATH, which reads the board (`identify`, `tree`, `show <ref>`…) and sets the caller's status; and `agent-board mcp`, the same as a few MCP tools agents get, whose instructions say only to read `agent-board --help` (ADR-0010). For an orchestrator, both also start, message, watch and close agents (ADR-0011).
_Avoid_: API, control API

**Ref**:
How the board CLI names a thing: `<kind>:<start of its id>` (`zone:4f2a`, `agent:9c1e`), a unique name, or `me`.

**Board token**:
A session's own token, in its env as `AGENT_BOARD_IDENTITY`, which tells the daemon which session a CLI or MCP call comes from. Unlike the hook token it can't post hook events, so the model may see it.

**Orchestrator**:
An agent the user lets start, message, watch and close other agents through the board CLI and MCP (`agent-board new|send|wait|read|interrupt|close`), and join them with **edges** (`agent-board edge add|remove`), inside its **orchestrator scope**. Only the user lets one: by a zone's setting, **Let agents orchestrate** (on by default), for the agents they start there, or for one agent by hand. An agent an orchestrator starts never is one (ADR-0011).
_Avoid_: master (that is the cmux dev harness's session), lead (fine in prose, not as the term)

**Orchestrator scope**:
Where an orchestrator may act: its zone (the default), its repo, or the whole board; and always on the agents it started.
_Avoid_: scope alone (that is a tracker's)

**Spawned by** / **started by**:
The orchestrator that started an agent (`spawnedBy`); none for an agent the user started.

**Crew**:
The agents an orchestrator started, drawn in a dashed frame beside it that moves with it (or, by a board setting, each with a "from" chip).
_Avoid_: children, workers (fine in prose)

**Activity log**:
The orchestrators' append-only log: who did or tried what to whom, and when, done or refused (`orchestrator.activity`): the agents they start, message, interrupt, close and remove, the edges they add and remove, and every agent's explicit **hand-offs**.
_Avoid_: audit log (fine in prose)

**Needs-you inbox**:
The list of agents in `waiting` or `needs-permission`, or with any permission prompt pending, answerable without opening their shell.

**Onboarding**:
The first-run flow: Welcome, Connect your tools (each CLI, GitHub, Linear, global hooks and notifications, checked and fixed in place), a quick tour of the board, and Finish (a first zone or the **sample board**). It opens by itself only on an empty board that has never been through it, can be skipped at any step, and Help › Getting started reopens it.
_Avoid_: wizard, setup (for the whole flow)

**Sample board**:
A board of made-up agents in every state that onboarding can show. Drawn by the app alone: nothing behind it runs or is saved, and no tokens are spent.
_Avoid_: demo mode

**Notification**:
The OS notification the app raises when an agent starts waiting, needs permission, fails or is done: once per state change. Clicking it opens the agent. A **muted** agent raises none but still shows in the needs-you inbox, whose size is on the dock badge.

**Permission prompt**:
A tool call, by an agent or one of its subagents, waiting for the user's allow or deny. An agent can have several at once, and is `needs-permission` while any is pending.
_Avoid_: approval (that is a condition's command approval, ADR-0009), permission request (that is the harness's hook event)

**Hold**:
The daemon keeping a harness's `PermissionRequest` hook open so the inbox can answer the permission prompt. When the hold lapses unanswered, the agent's terminal asks instead.

**External session**:
A harness session the app did not spawn (started in another terminal) but discovered through the opt-in global hooks and placed on the board: in the zone matching its folder, else in the **Unsorted** group. Its tile can be dragged anywhere, out of Unsorted too, and keeps that place; its folder only says where a new one goes. It has no terminal in the app: it can be **removed from the board** (never stopped: one still running elsewhere says so first, and comes back if it starts again), or **resumed in agent-board**, which adopts it as an agent under the same session id (`claude --resume`, `codex resume`) in its tile's place, keeping its connectors, the external tile going. It resumes in its own folder by default, an agent that doesn't own its worktree, so deleting it only takes it off the board; or, in git, in a new worktree cut from its branch; or, its folder gone, in one the user picks. The app asks first, Cancel the default, warning when that folder is the repo's main checkout, and when the session may still be running elsewhere (it never reported its end, or its transcript was written since).

**Unsorted**:
A normal **group** zone the daemon makes on demand, right of the zones and level with the topmost, for external sessions whose folder is in no zone and that haven't been placed anywhere yet (and, when the app starts, for those of a board from before it was a group). It is moved, resized, renamed, recoloured, tidied and dissolved like any group, and a tile leaves it by being dragged out. It is found by a mark the daemon keeps, not its name, so renaming it loses nothing; once it is bound to a repo, removed or dissolved, the next such session gets a fresh one. Dissolving it (or any group) from its ⋯ menu, which the daemon does in one step, leaves its tiles loose on the board where they are drawn.
_Avoid_: inbox (that is the needs-you inbox)

### Flows

**Edge**:
A directed link from agent A to agent B that delivers A's **payload** to B when A finishes, optionally gated by a **condition** and either automatic or manual. Drawn by dragging from a tile's **flow port** onto another agent's tile (only agents' tiles take one, and Escape calls the drag off); let go, it is selected and its **Edge rules** open. It is coloured and labelled with its payload (`final message`, `plan.md`), like the issue brief, with its trigger's mark (a tick for auto, a play for manual) and, on a manual one, a Send button. Kept by the daemon (`flow_edges`), and deleted with either agent. At most one joins A to B; auto edges never make a loop, as the agents would answer each other for ever. Each keeps its history: what it delivered, skipped (and why), **held** and released. Under its label it says when it last delivered ("delivered 14:02"), and its Edge rules show what that hand-off carried, while the daemon remembers it. Making or deleting one can be undone. An **agent-made** edge is one an orchestrator made: dashed, saying who made it, and the user's to change or delete like any other.
_Avoid_: connection, wire; a **connector** is the whiteboard annotation, which carries nothing

**Flow port**:
One of an agent tile's two square, coloured ports, below the middle of its left and right sides: an edge leaves from the right one (filled, the out port) and arrives at the left one (hollow, the in port).
_Avoid_: handle (a connector handle is round)

**Hand-off**:
An agent passing on its payload: **explicitly**, by calling `agent-board handoff` or the Board MCP's `handoff` tool (`board.handoff`), along its own outgoing edges (or one, `--to`), each taking the part of what it hands over that matches what the edge carries (a message, a handover file, JSON); or **inferred**, its own turn ending with a final message (its `Stop` hook's `last_assistant_message`), along the auto edges it didn't hand off along explicitly that turn. Every hand-off goes the same way: along each of the agent's auto edges, each carrying its own payload as it is at that moment, delivered to B as its next message, as a scheduled run's prompt is (one line, so a multi-paragraph message arrives joined), and relaunching B if its session has ended. It arrives headed "Hand-off from A (its final message):" (or with the payload's own name, "(its plan.md):", or "(its review, round 2):" for a review doc), with no control characters, so another agent's words never start as one of B's commands (`/`, `!`) or drive its terminal. A delivery to a B that is still working, rate-limited, showing you a permission or question prompt, or being typed to is skipped, saying why, unless the edge delivers by **queue after turn**: then it waits until B's turn ends (tried again every minute too), a newer one replacing it. A paused edge delivers nothing by itself. An edge with **conditions** checks them first, and **holds** the hand-off while any fails. A B whose last message asked you something still takes it: the hand-off is its next input. A shows `handing-off` until its deliveries have landed, unless it is waiting for you, which it goes on showing. An edge's Send delivers its payload as it is now (A's last final message, which outlives a daemon restart, or its file) the same way, whatever its conditions say, dropping any held hand-off. On the board, a hand-off shows along its edge for at least a moment, however soon it landed: the payload travels the edge, A's robot hands it on, and B's tile reads "receiving…" (a look, not an agent state). A skipped delivery shows nothing travelling.

**Edge rules**:
The panel on the right of the board for the **edge** selected, opened on a new one as soon as it is drawn, the board panning clear of it: its ends, its payload (and file), its trigger, whether it delivers to a busy B as a new message or by queue after turn, its **conditions** with how each last checked, a preview of what it would carry now, its history, Pause edge (a paused edge's auto hand-offs are skipped and what it holds or queued waits; Send still sends), Delete and Send now.
_Avoid_: edge popover, edge settings

**Payload**:
What an edge carries: A's final message, a markdown file from A's worktree (`handover.md` unless set, such as `plan.md`), or a JSON file from it (`handoff.json` by default), checked to be JSON and sent on one line. A file must be inside A's worktree, through any link, and at most 64 KB; one missing, too big or not JSON is skipped, saying why.

**Condition**:
What must hold before an auto edge delivers a hand-off; all of an edge's must pass. **Gate green**: a gate command (`pnpm check:local`) passes in A's worktree, run again only once A commits, one run shared by every edge asking, and only once the edge's other conditions pass. **PR checks**: the checks of A's newest pull request pass. **Issue label**: A's linked issue has the label. **Custom script**: a command exits 0 in A's worktree. A gate or script runs only once you **approve** what it runs, shown whole: the command, the `package.json` script it names, and the files they name, by hash. If any of those change, it waits for your approval again (ADR-0009).
_Avoid_: rule (the rules are all of an edge's settings), filter

**Held**:
A hand-off an edge keeps, as it was read when A handed off, until its conditions pass: checked again every minute, whenever A's pull requests change, and when its conditions do, then delivered. A newer hand-off replaces it, Send delivers now instead, and changing the edge's payload, or making it manual, drops it. A paused edge keeps it until resumed. The edge says what it is held until ("held until CI green"). A held (or queued) file is kept as a copy until it is delivered, or, if Settings says **path only**, read again when it is delivered (ADR-0009). Drop in the Edge rules throws it away.
_Avoid_: queued (a queued delivery waits for B's turn to end, by **queue after turn**, not for conditions), pending

**Reviewer**:
An ephemeral agent spawned from an implementer's tile (its More menu, or the Review tab's Start round) to review its work: in the implementer's harness and zone, on a branch of its own from the tip of the implementer's branch (`<branch>-review-r1`), told to review the diff since the commit the implementer started from, change nothing, and reply with only its review doc. Its tile is dashed. Once its doc is in, it is stopped (`done`); the next round, or dismissing its round, deletes it and its worktree.
_Avoid_: review agent

**Review doc**:
What a reviewer leaves behind: its final message, markdown with a title, a `Verdict:` line (only `Approve` or `Changes requested` count; anything else approves nothing) and findings under `## Blocker`, `## Major` and `## Minor`, each a **bold** title, a `path:line` and why; one a later round finds fixed has its title struck through. Kept by the daemon with its round, shown in the implementer's session window, on a **Review** tab beside its terminal (AD2): the rounds on the left, the doc in the middle (its verdict and findings by severity with file:line chips, or the markdown as it is when not in that format), and its actions on the right. **Send to implementer** delivers it as a hand-off (`Hand-off from <reviewer> (its review, round N): …`), skipped as any hand-off is when the implementer can't take it now; **Approve and merge** squash-merges the implementer's open pull request, from the latest round only, once it approves with no open blocker and the PR's checks, looked at again first, aren't pending or failing; and only at the commit the round reviewed, so nothing pushed since is merged. Dismissing the latest round closes its tab; asked for from the tile, it opens again, with every doc.

**Review round**:
One numbered review of an implementer's work: its reviewer and the commit it reviewed, and then its doc, or why it has none (the reviewer ended first, or was deleted or dismissed before it left one). Rounds are kept per implementer, one at a time, at most its **review cap** of rounds that left a doc (3 unless set, 1 to 10, from the Review tab's rail), and go with it. A later round's reviewer is given the last doc, to say what was fixed.

**Trigger**:
What starts a long-lived agent run: a cron schedule or a webhook.

**Run**:
One execution of a long-lived agent, kept in run history. A scheduled run sends the schedule's prompt to the agent's session as its next message, relaunching the agent first if its session has ended; a fire time at which the agent is still working, rate-limited, waiting for you, or being typed to, is recorded as skipped.

### Infrastructure

**Daemon**:
The background process (`agent-board daemon`) that owns sessions, PTYs, the database, the scheduler and the webhook listener. The app is its client.

**Terminal backend**:
Where a session's terminal lives. v1 has only the built-in PTY. (cmux is the dev harness for building this repo, not a backend.)

**Tracker**:
An issue-tracker provider behind a common interface: Linear or GitHub Issues. Each zone picks one, and a scope in it.

**Scope**:
Where a tracker's issues live, and what a zone is bound to: a Linear **team** (keyed `ACME`) or a GitHub repo (`owner/repo`). "Scope" is the provider-neutral term in code and the API; the UI uses the provider's own word ("team", "repo").
A tracker scope can be narrowed to one **project** of it (a Linear project, kept by its ID): the zone's issue picker then lists only that project's issues. GitHub has none.
_Avoid_: project (for a scope: a Linear project is a part of one)

**Linked issue**:
The tracker issue an agent works on, shown on its tile. Kept as a snapshot (provider, ID, title, URL) taken when it was linked or the agent was started from it. Linking never renames the agent's branch; starting from an issue names it (`acme-12-…`, `gh-34-…`). A GitHub issue's ID is `owner/repo#34`, shown as `#34`.

**Tracker credential**:
The API key or OAuth token agent-board uses for a tracker. Lives only in the OS keychain (service `agent-board`, account = provider), never in the database. GitHub has none: agent-board uses the `gh` CLI's own login.

**Pull request** (PR):
A GitHub pull request whose head is an agent's branch, shown on its tile with its state (open, draft, merged, closed) and its checks (passing, failing, pending). Found for every agent whose repo is on GitHub, whatever its zone's tracker.

**Status file**:
`.agent-board/status.json` in a worktree, written by harness hooks; the contract between workers and whoever supervises them. It names its writer's `session_id`, so an external session's tile shows the state, summary and doc paths only for the session that writes it (`StatusFile` in the protocol).
_Avoid_: worker status
