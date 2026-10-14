---
status: accepted
---
# Storage: one SQLite database owned by the daemon

Board state (zones, tiles, sessions, edges, schedules, runs, tracker links) lives in one SQLite file under the user's app-data directory, opened only by the daemon via Node's built-in `node:sqlite` (`DatabaseSync`) in WAL mode. The schema is defined by numbered, forward-only SQL migrations in the repo (`packages/daemon/src/migrations/NNNN_name.sql`), applied at daemon start and tracked with `PRAGMA user_version`. Clients never open the file; they go through the daemon API, which keeps one writer and makes export/import a daemon operation.

## Considered options

- **`better-sqlite3`** — the original choice. Rejected: it is a native module, so it would have to be built for Electron's ABI for the daemon (which runs on Electron's Node, ADR-0001) and for Node's ABI for Vitest, from one `node_modules`. `node:sqlite` ships in both Node 24 and Electron 44's Node (24.21, SQLite 3.53), has the same synchronous API shape, and needs no build step. Trade-off: `node:sqlite` is still marked experimental (stability 1.1, release candidate) in Node 24, though it prints no warning there; revisit if its API shifts. This reverses an accepted decision inside a feature ticket, so it needs the maintainer's sign-off on the PR.

## Amendments

**2026-10-10**: `migrate()` runs migrations with foreign keys off, and turns them back on afterwards if they were on. SQLite can't drop a `NOT NULL`, so making `zones.repo_root` nullable rebuilds the `zones` table (create, copy, drop, rename). With foreign keys on, dropping a table that `agents` and `shells` reference fails. Before each migration commits, `migrate()` runs `PRAGMA foreign_key_check`. A broken reference fails the migration and rolls it back, so turning foreign keys off never lets a migration leave a dangling reference. This is SQLite's documented procedure for changing a table's schema.

**2026-10-10**: board items live in their own `board_items` table, with kind-specific fields in a JSON `data`
column so a new kind needs no migration. The daemon checks `data` against the item's kind on every write, and caps it
at 64 KiB. One rule lives in the schema rather than the daemon: a `BEFORE DELETE ON zones` trigger moves a removed
zone's items out onto the board at the same absolute place, so no code path that removes a zone can leave items
pointing at it. `zone.remove` then announces the moved items as `item.updated`. A migration that rebuilds `zones`
(drop and recreate) drops this trigger with it, and must create it again; `migrate.test.ts` checks the trigger
exists after every shipped migration.

**2026-10-10**: image bytes are not in SQLite. The daemon keeps them as files under `<data dir>/images/`,
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

**2026-10-10**: connectors are not board items: they have their own `connectors` table (migration 0016), not
`kind = 'connector'` in `board_items`. An item's place, size, `z` and zone mean nothing to a line, and a connector joins
objects from five tables (zones, items, agents, shells, external sessions), so its ends are a `(type, id)` pair and a
side, in columns. SQLite can't hold that as a foreign key, so five `AFTER DELETE` triggers (`connectors_leave_deleted_*`)
delete a connector with either object: no code path that removes one can leave it dangling. A migration that rebuilds
one of those tables drops its trigger and must create it again; `migrate.test.ts` checks all five exist. The daemon
announces `connector.updated` and `connector.removed` for what a client does to a connector, not for one that goes with
its object: clients drop it as they hear the object go. An external session is only hidden when dismissed (its row
stays), so its connectors are hidden with it and return with it. The daemon checks both ends exist when a connector is made.

**2026-10-10**: how the app left the board (its viewport, its session windows, popped-out windows' places, the
sessions the restart banner was dismissed for) lives in a `view_state` key/value table of JSON values (64 KiB each),
behind `view.get` and `view.set`, not in the renderer's localStorage: a hard kill can lose what Chromium hasn't flushed,
and the daemon owns board state. Sessions' saved screens are files under the data dir, not rows: they are large, written
often, and only read back whole.
