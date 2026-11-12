---
status: accepted
---
# Storage: one SQLite database owned by the daemon

Board state (zones, tiles, sessions, edges, schedules, runs, tracker links) lives in one SQLite file under the user's app-data directory, opened only by the daemon via Node's built-in `node:sqlite` (`DatabaseSync`) in WAL mode. The schema is defined by numbered, forward-only SQL migrations in the repo (`packages/daemon/src/migrations/NNNN_name.sql`), applied at daemon start and tracked with `PRAGMA user_version`. Clients never open the file; they go through the daemon API, which keeps one writer and makes export/import a daemon operation.

## Considered options

- **`better-sqlite3`** — the original choice. Rejected: it is a native module, so it would have to be built for Electron's ABI for the daemon (which runs on Electron's Node, ADR-0001) and for Node's ABI for Vitest, from one `node_modules`. `node:sqlite` ships in both Node 24 and Electron 44's Node (24.21, SQLite 3.53), has the same synchronous API shape, and needs no build step. Trade-off: `node:sqlite` is still marked experimental (stability 1.1, release candidate) in Node 24, though it prints no warning there; revisit if its API shifts. This reverses an accepted decision inside a feature ticket, so it needs the maintainer's sign-off on the PR.

## Amendments

**Update**: `migrate()` runs migrations with foreign keys off, and turns them back on afterwards if they were on. SQLite can't drop a `NOT NULL`, so making `zones.repo_root` nullable rebuilds the `zones` table (create, copy, drop, rename). With foreign keys on, dropping a table that `agents` and `shells` reference fails. Before each migration commits, `migrate()` runs `PRAGMA foreign_key_check`. A broken reference fails the migration and rolls it back, so turning foreign keys off never lets a migration leave a dangling reference. This is SQLite's documented procedure for changing a table's schema.

**Update**: with foreign keys off, no `ON DELETE` action fires during a migration either: deleting a row leaves the rows that point at it pointing at nothing, and `foreign_key_check` then fails the migration on a user's data. So a migration that deletes rows (with `DELETE`, or `REPLACE` on a conflict) must first delete or update the rows that point at them. `migrate.test.ts` scans every shipped migration for a delete that comes before any write to a table referencing it. It checks the order and that the write is there, not that its `WHERE` matches: a test with child rows over the migration does that.

**Rolling back**: migrations stay forward-only, but an older build must never be stranded by a newer database, nor drop its data. Before each run that applies a migration, `migrate()` copies the database beside it with `VACUUM INTO`, as `<file>.v<version>.bak`, and keeps the three most recent; a failed copy stops the migration. The backup clears the copies of held and queued hand-off files (ADR-0009), which are meant to last only until delivered. Each migration it applies is recorded in a `schema_migrations` table, kept outside the numbered migrations, with a checksum of its SQL and whether it is backward-safe: its SQL's first line is `-- backward-safe: <why>` (or `-- not backward-safe: <why>`). A database that ran a migration as different SQL from the build's own under that number (one reverted, then landed again changed) is refused, naming the build that ran it or the backup from before it, as migrating on would skip the new SQL. A test freezes each shipped migration's checksum, so an edit to one fails there and never stops a user's board. An older daemon opens a newer database as it is when every newer migration is recorded as backward-safe, and logs that it did. Otherwise it refuses, naming the newest backup it can migrate from and a command that moves the newer database aside (never deleting it) and copies the backup in. Prefer additive migrations, which can be backward-safe. Rejected: down migrations, which an older build doesn't have the code for. `docs/rolling-back.md` is the user's side of this.

**Update**: board items live in their own `board_items` table, with kind-specific fields in a JSON `data`
column so a new kind needs no migration. The daemon checks `data` against the item's kind on every write, and caps it
at 64 KiB. One rule lives in the schema rather than the daemon: a `BEFORE DELETE ON zones` trigger moves a removed
zone's items out onto the board at the same absolute place, so no code path that removes a zone can leave items
pointing at it. `zone.remove` then announces the moved items as `item.updated`. A migration that rebuilds `zones`
(drop and recreate) drops this trigger with it, and must create it again; `migrate.test.ts` checks the trigger
exists after every shipped migration.

**Steps cards**: a steps card is a board item of kind `steps` whose `data` holds the whole set: its
title, who made it and who answers it, every step with its tick or answer, the answers as last sent, and who waits on
which step. No table of its own: the item is the set, so there is nothing to keep in step with it, it survives a
restart, it goes only when the user takes it off the board, and `item.updated` tells the app of each change. Its limits
(50 steps, 12 questions, 9 choices, 500 characters a text, 2,000 an answer) keep an everyday card far inside the 64 KiB
cap, but a card at every limit at once would pass it. So the answers as last sent are kept only as short fingerprints,
and each change is measured before it is saved: one that would take the card past the cap is refused, saying to shorten
its longest answers or steps, and tells no one. Its own methods (`steps.ts`) change it, each change to a card in turn.

**Crew cards**: a running crew's card is a board item of kind `crew` whose `data` is a copy of what its crew's rows say
(`CrewCardData`: its title, its members, the crew as `orchestrator.crews` gives it, when its phase began), and `tiles`,
the one field that is the user's. No table or column ties a card to its crew: the card names its crew (`crewId`), and
`crew-cards.ts` finds a crew's card among the `crew` items. The copy is never the truth. Every `item.create` and
`item.update` of a crew card has its data written over from the crew's rows, so the app needs only `item.list` and
`item.updated` to draw one, and an undo of a removal brings the card back as its crew is now. As the daemon starts,
each card is brought up to date, a running crew without one gets one, and a card that names no crew is removed.

**Memories and queues**: a memory or a queue is a board item (kind `memory`, `queue`) whose `data` holds only its
title, maker, scope switch (`noAgents`), audience (a queue's) and a count for the card, as its contents would soon pass
the 64 KiB cap: up to 500 entries and 8 MB a memory, files up to 1 MB, and 200 open jobs a queue. Its entries and jobs
are rows of `memory_entries` and `queue_jobs`, and every change to one is a row of `board_history` holding the row as
the change left it (the last 20 a row, 5 for a file), which is what `history` lists and `restore` puts back. A memory's
or queue's history holds at most 8 MB of values besides: past that the oldest versions go, those of rows removed since
first, so adding and removing files in a loop can't grow the database without end. A removed row keeps its remove. File
entries are text kept in their row, not on disk as images are, so a file's versions and its restore go through the same
table with nothing to sweep. Neither table has a foreign key to `board_items`: undoing an item's delete makes it again
with the same id, and finds its rows still there. The daemon sweeps rows whose item is gone as it starts. A change runs in
one transaction, and then updates the card's count, so `item.updated` tells the app of every change. Which agents read
an entry is a row of `memory_reads` per entry and agent session, holding the agent's name as it read and when it last
did: written when an agent's read returns that entry's whole text (a fact in a listing, a document only when it is
named), never for the user's own reads. Readers are of the text they read: a change to an entry's text (an edit, its
key set again, a restore) clears them, and a pin or a confirm keeps them. A memory's readers are those of the entries it
holds now. It has no foreign key either, so a removed entry put back as it was keeps its readers, and the same sweep
takes the rows of memories that are gone. A confirm is a `board_history` row with no value, the newest replacing one
just before it, and the per-row trim counts only the others.

Removing a zone still moves its items loose, but `board_items_leave_removed_zone` now also sets a memory's or queue's
`noAgents`: loose, it would otherwise widen from its zone's agents to every agent on the board. The user chooses its
scope again from there. The trigger was dropped and made again for this, as the rule above asks.

**Update**: image bytes are not in SQLite. The daemon keeps them as files under `<data dir>/images/`,
content-addressed as `<sha256>.<ext>`, so the same bytes pasted twice are stored once. An image item's `data` holds only
the sha256 and extension; a link card's holds its URL and the page's metadata, with its favicon kept the same way. The
app hands the daemon the bytes by writing a file in `images/incoming/` and calling `image.import` (a 20 MB image as base64
would not fit a JSON-RPC line); the daemon sniffs the format from the bytes, refuses anything but PNG, JPEG, GIF and
WebP (never SVG, which can carry script) and over 20 MB, and moves the file into place. Files no item references are
swept when the daemon starts and after an item is deleted or its data changes, sparing any stored in the last ten
minutes, since an image is stored a moment before its item is made. Export and import must carry these files. An
image pasted into an agent's composer goes through `images/incoming/` too, with `image.paste`, which keeps a
copy in `<data dir>/pasted-images/` for the agent to read: nothing on the board references it, so the sweep must not
see it.

**Update**: connectors are not board items: they have their own `connectors` table (migration 0016), not
`kind = 'connector'` in `board_items`. An item's place, size, `z` and zone mean nothing to a line, and a connector joins
objects from five tables (zones, items, agents, shells, external sessions), so its ends are a `(type, id)` pair and a
side, in columns. SQLite can't hold that as a foreign key, so five `AFTER DELETE` triggers (`connectors_leave_deleted_*`)
delete a connector with either object: no code path that removes one can leave it dangling. A migration that rebuilds
one of those tables drops its trigger and must create it again; `migrate.test.ts` checks all five exist. The daemon
announces `connector.updated` and `connector.removed` for what a client does to a connector, not for one that goes with
its object: clients drop it as they hear the object go. An external session is only hidden when dismissed (its row
stays), so its connectors are hidden with it and return with it. The daemon checks both ends exist when a connector is made.

**Update**: how the app left the board (its viewport, its session windows, popped-out windows' places, the
sessions the restart banner was dismissed for) lives in a `view_state` key/value table of JSON values (64 KiB each),
behind `view.get` and `view.set`, not in the renderer's localStorage: a hard kill can lose what Chromium hasn't flushed,
and the daemon owns board state. Sessions' saved screens are files under the data dir, not rows: they are large, written
often, and only read back whole.

**Update**: a session window's terminal tabs are rows of the `shells` table with an owner (`owner_kind`,
`owner_id`: for now an agent, by its session id), not a table of their own: a tab is a pane tree, as a shell tile is, so
splitting, resizing, resuming and naming panes stay one code path, and moving a tab between owners (or onto the board as
a tile) later changes only those two columns. An owned row has no zone or place, so it is never a tile. The agent's own
tab is such a row too, made when it is first split, its first pane the agent's own session, which no shell call ends.
`isOwnTab` and `isOwnedBy` in the protocol say which is which. Slice 2 (migration `0036_shell_tile_tabs`) lets a shell
tile own tabs too (`owner_kind` `'shell'`, `owner_id` the tile's id). The tile's own row stays its first tab, so no pane
moved; its tabs start in its folder and its zone. Deleting the tile ends its tabs, and when its first tab loses its last
pane the next tab's layout moves into the tile's row, so the tile keeps its place, name, folder and connectors. A pane
in a tile's tab speaks for the tile on the board (`sessionCaller`), and one in an agent's tab for the agent.
Slice 3 (migration `0037_shell_tab_order`) moves tabs: `shell.moveTab` rewrites a row's owner, or its zone and place,
in one transaction and never touches its sessions, so the PTY, its scrollback and folder go with it, and `sessionCaller`,
reading the owner as it is asked, has its panes speak for the new owner at once. A shell tile moving into tabs takes its
own tabs with it, re-owned to the same owner, so a tab's owner is still always a tile or an agent. `tab_order` places a
tab among its owner's (NULL for older rows, which sort first by rowid), so one moved in lands last and an undone move goes
back where it was. A pane leaving a split is a new row (`shell.movePane`), and `shell.returnPane` puts the source's layout
back verbatim for undo. Connectors on a tile that becomes a tab stay in the table and are drawn again if it comes back.

**Crew prefabs**: the crew prefab library is one table for the whole app, `crew_prefabs`, keyed by name in
any case, as `default_roles` is: not one per board, so every board has the same library. A row's body is the prefab's
`.crew.json` text, read with the file's own strict parser on every write and read, so the table and a shared file can
never mean different things, and a field the parser drops can't survive in a row. The built-ins are not rows: they live
in the code, so a new release can change them, and no row may take a built-in's name.

**Running crews**: a crew started from a prefab with reviewers at the hand-off is a row of `crews` (migration
`0076_crews`): the prefab's `.crew.json` text as it was started, so editing or removing the prefab later changes no
running crew; its zone, its starter (null for the user), its builder's session, the prompt, its round and round limit,
whose turn it is (`phase`, since `phase_at`), and why it stopped. Each reviewer it started is a row of `crew_reviewers`,
with its round and, once read, its review's verdict, text and open blockers. Neither table points at `agents` with a
key: a crew keeps its history when the user deletes one of its agents. The loop reads what happened while the daemon
was down from the agents' files on its next start.

**Update**: a session window's panes are kept in a table of their own, `window_layouts` (migration
`0039_window_layouts`), one row per owner (`owner_kind`, `owner_id`, as a tab's), holding `WindowLayout` JSON: a split
tree whose leaves are panes, each an ordered strip of surfaces (`own`, `shell` by id, or `session`, another agent or
shell tile shown there) and the one it shows. Tabs stay rows of `shells`, so nothing moves, migrates or restarts: an owner
with no row shows one pane holding its tabs in order, which is today's strip, and a tab's own splits stay in its row. The
row says only where each surface is drawn; which surfaces there are is the shells table's and the board's, so the window
reconciles the two as it reads them (gone tabs leave, new ones join a pane), and the daemon never rewrites a layout when
a tab moves. A layout is refused for an owner being deleted, and goes with it: an agent's in its delete, a shell tile's
by a trigger whenever its `shells` row goes. Rows can outlive what they name, harmlessly, as the window drops what is
gone when it next reads them: a tile that became another's tab keeps its row (so an undo finds it), and a layout keeps
another session's tab until the window opens after it went. Tabs split inside themselves before panes are laid out as
panes once, by `shell.unsplitTabs`, which the window calls to read its layout: the daemon moves each extra pane into a
tab of its own (as `shell.movePane` does) and rewrites the layout in the window's turn, so no window open twice, or
closed half way, can see half of it.
