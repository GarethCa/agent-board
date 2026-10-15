---
status: accepted
---
# Storage: one SQLite database owned by the daemon

Board state (zones, tiles, sessions, edges, schedules, runs, tracker links) lives in one SQLite file under the user's app-data directory, opened only by the daemon via Node's built-in `node:sqlite` (`DatabaseSync`) in WAL mode. The schema is defined by numbered, forward-only SQL migrations in the repo (`packages/daemon/src/migrations/NNNN_name.sql`), applied at daemon start and tracked with `PRAGMA user_version`. Clients never open the file; they go through the daemon API, which keeps one writer and makes export/import a daemon operation.

## Considered options

- **`better-sqlite3`** — the original choice. Rejected: it is a native module, so it would have to be built for Electron's ABI for the daemon (which runs on Electron's Node, ADR-0001) and for Node's ABI for Vitest, from one `node_modules`. `node:sqlite` ships in both Node 24 and Electron 44's Node (24.21, SQLite 3.53), has the same synchronous API shape, and needs no build step. Trade-off: `node:sqlite` is still marked experimental (stability 1.1, release candidate) in Node 24, though it prints no warning there; revisit if its API shifts. This reverses an accepted decision inside a feature ticket, so it needs the maintainer's sign-off on the PR.

## Amendments

**Update**: `migrate()` runs migrations with foreign keys off, and turns them back on afterwards if they were on. SQLite can't drop a `NOT NULL`, so making `zones.repo_root` nullable rebuilds the `zones` table (create, copy, drop, rename). With foreign keys on, dropping a table that `agents` and `shells` reference fails. Before each migration commits, `migrate()` runs `PRAGMA foreign_key_check`. A broken reference fails the migration and rolls it back, so turning foreign keys off never lets a migration leave a dangling reference. This is SQLite's documented procedure for changing a table's schema.

**Update**: board items live in their own `board_items` table, with kind-specific fields in a JSON `data`
column so a new kind needs no migration. The daemon checks `data` against the item's kind on every write, and caps it
at 64 KiB. One rule lives in the schema rather than the daemon: a `BEFORE DELETE ON zones` trigger moves a removed
zone's items out onto the board at the same absolute place, so no code path that removes a zone can leave items
pointing at it. `zone.remove` then announces the moved items as `item.updated`. A migration that rebuilds `zones`
(drop and recreate) drops this trigger with it, and must create it again; `migrate.test.ts` checks the trigger
exists after every shipped migration.

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

**Update**: a session window's panes (BH1) are kept in a table of their own, `window_layouts` (migration
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
