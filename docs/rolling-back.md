# Rolling back to an older build

The board lives in one SQLite file, `agent-board.db`, in the app's data directory (`~/Library/Application Support/agent-board/` on macOS). Each build knows a number of schema migrations. When a newer build starts on the file, it migrates it to its own schema version.

## The backups

Before the daemon applies any migration, it copies the database beside it, as `agent-board.db.v<version>.bak`: `agent-board.db.v54.bak` is the board as it was at schema version 54, just before a newer build migrated it. It keeps the three most recent backups and removes older ones. A new, empty database gets no backup, as it has nothing to lose. If the daemon can't make the backup, for example because the disk is full, it doesn't migrate and doesn't start.

A backup holds the board, with one thing taken out: the copies of hand-off files held or queued on an edge. Those copies are meant to last only until the hand-off is delivered or dropped, so a backup doesn't keep them. A board restored from a backup reads each held or queued file again when it delivers it, as the "Path only" setting does. A final message is kept anyway, so its copy stays.

## Opening the database with an older build

Each migration says whether it is **backward-safe**: whether an older daemon can open the database after it and carry on. A migration that only adds a table, or a column with a default, is backward-safe. One that drops, renames or rewrites anything an older daemon reads is not. The daemon records each migration it applies, and whether it was backward-safe, in the database's `schema_migrations` table.

When an older build starts on a newer database:

- If every newer migration is backward-safe, it opens the database as it is. It writes a line saying so in `daemon.log`. The newer build opens the database again later with nothing to redo.
- Otherwise it doesn't start. The window says why, and the reason names the backup to go back to and the exact command that restores it. For example:

  ```sh
  cd ~/Library/Application\ Support/agent-board && mv agent-board.db agent-board.db.v55.newer && cp agent-board.db.v54.bak agent-board.db
  ```

  Quit agent-board first, then run the command the window gives you, then open the app again. The command never deletes the newer database: it stays beside the backup as `agent-board.db.v55.newer`. Run twice, the command stops at its `test` and moves nothing. It is for a POSIX shell (macOS, Linux).

The daemon also refuses a database that ran a migration as different SQL from the one this build has under that number, as when a migration was withdrawn and later came back changed. Migrating on would skip the changed migration. Open the board with the build that last ran on it, or go back to the backup from before that migration with the command the window gives you, the same way.

## What you lose by restoring

The backup is the board as it was just before the upgrade. Anything you did on the newer build is in the `.newer` file, not the backup. To get it back, install the newer build again and move the `.newer` file back to `agent-board.db`, with the app quit. The `.newer` file is the whole board as it was, held hand-off copies included: delete it once you don't need it.

Builds from before backups and backward-safe migrations were added refuse any newer database. There, restoring by hand from an older copy of `agent-board.db` is the only way back.

## For contributors: writing a migration

Start every new migration in `packages/daemon/src/migrations/` with a first line that says which kind it is, and why. Only the first line counts:

```sql
-- backward-safe: a new table that older daemons never read.
```

```sql
-- not backward-safe: renames zones.name, which older daemons read.
```

Prefer additive migrations: new tables, and new columns with a default, so an older daemon's inserts still work. A migration's line and a checksum of its SQL are recorded when it runs, so don't change it after it ships: a board that ran the old SQL won't start on a build with the new. Whole-line comments and spacing aren't part of the checksum; a comment after SQL on the same line is. Each shipped migration's checksum is listed in `packages/daemon/test/migration-checksums.json`, and a test fails when a migration no longer matches its line, so add a new migration's line there and change a shipped one with a new migration instead. When a release adds a migration that isn't backward-safe, its release notes say so and point here.
