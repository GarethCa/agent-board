import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { keyedQueue } from './keyed-queue.ts';
import { invalidParams, nameParam, optionalStringParam, paramsObject, requiredNameParam, stringParam } from './params.ts';
import { paneIds, parsePaneLayout, removePane, setPaneName, setSplitRatio, splitPane, type PaneLayout, type SplitDirection } from './pane-layout.ts';
import type { DaemonEvent, DaemonMethods, SessionInfo, Shell, TileMove } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import type { SessionHost } from './sessions.ts';
import { folderPath } from './repo-zone.ts';
import { frontZ, moveParams, optionalPlaceParam, saveMove, tilePosition, zoneIdParam, type PositionColumns } from './tile-position.ts';

/** The size a pane starts at; the window sizes it to itself as soon as it attaches. */
const INITIAL_SIZE = { cols: 80, rows: 24 };

/** The line between a resumed pane's old output and its new shell. Dim, as the terminal's own notes are. */
const RESTORED_MARKER = '\x1b[2m── restored after a restart ──\x1b[0m';

/**
 * Undoes the modes a program left on when the shell under it went (vim, less, htop): back to the normal screen, mouse
 * reporting off, normal cursor keys and keypad, no bracketed paste, the cursor shown and plain text. Otherwise the new
 * shell would start inside the old program's alternate screen, with clicks typed into its prompt.
 */
// ?1047l, not ?1049l: that would also put the cursor back where the program saved it, over the old output.
export const RESET_MODES =
  '\x1b[?1047l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1l\x1b>\x1b[?2004l\x1b[?25h\x1b[0m';

type ShellMethods = Pick<DaemonMethods, Extract<keyof DaemonMethods, `shell.${string}`>>;

interface ShellRow extends PositionColumns {
  id: string;
  zone_id: string | null;
  name: string;
  cwd: string;
  layout: string;
  created_at: string;
}

interface ZoneFolder {
  /** Null for an unbound zone. */
  repo_root: string | null;
  folder: string;
  /** An unbound zone's default repo, or null. */
  default_repo: string | null;
}

export interface ShellHost {
  handlers<Context>(): RpcHandlers<ShellMethods, Context>;
  list(): Shell[];
  /** Moves the shell's tile, as `shell.move` does but at once, for a caller that moves several as one step. */
  move(shellId: string, move: TileMove): Shell;
  /** Tells clients about the shell the session is a pane of, if any: the pane's process has ended. */
  onSessionExit(session: SessionInfo): void;
  /**
   * Gives a plain shell session made on its own (`session.createShell`) a loose shell tile, so no session is left off
   * the board. The board finds it a place.
   */
  adopt(session: SessionInfo): void;
  /** Tells clients about the shell the session is a pane of, if any: the pane's shell is in another folder. */
  onPaneFolder(sessionId: string): void;
}

/**
 * Shell tiles: the `shell.*` RPC handlers over the `shells` table. A pane is a plain shell session of the
 * session host; the table keeps only how the panes are laid out. Changes to one shell run one at a time.
 */
export function createShellHost(options: {
  db: DatabaseSync;
  sessions: SessionHost;
  /** Where a loose shell, or one in an unbound zone, starts: the user's home directory. */
  homeDir: string;
  broadcast(event: DaemonEvent): void;
  log(message: string): void;
}): ShellHost {
  const { db, sessions, homeDir, broadcast, log } = options;
  const selectAll = db.prepare('SELECT * FROM shells ORDER BY rowid');
  const selectOne = db.prepare('SELECT * FROM shells WHERE id = ?');
  const selectZone = db.prepare('SELECT repo_root, folder, default_repo FROM zones WHERE id = ?');
  const namesInZone = db.prepare('SELECT name FROM shells WHERE zone_id IS ?');
  // A pane's session ID is a UUID, so it has no LIKE wildcards; the layout is stored as JSON.stringify writes it.
  const selectWithPane = db.prepare('SELECT * FROM shells WHERE layout LIKE ? ORDER BY rowid');
  const insert = db.prepare('INSERT INTO shells (id, zone_id, name, cwd, layout, x, y, z) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const updateName = db.prepare('UPDATE shells SET name = ? WHERE id = ?');
  const updateLayout = db.prepare('UPDATE shells SET layout = ? WHERE id = ?');
  const updatePlace = db.prepare('UPDATE shells SET zone_id = ?, x = ?, y = ?, z = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM shells WHERE id = ?');
  const paneSession = db.prepare('SELECT cwd, ended_at, stopped_by_restart, last_cwd FROM sessions WHERE id = ?');
  const queue = keyedQueue();

  const toShell = (row: ShellRow): Shell => {
    const layout = parsePaneLayout(JSON.parse(row.layout));
    const panes = paneIds(layout).map((id) => ({ id, session: paneSession.get(id) as PaneSession | undefined }));
    const endedPanes = panes.filter(({ session }) => session === undefined || session.ended_at !== null).map(({ id }) => id);
    const stoppedPanes = panes.filter(({ session }) => session?.ended_at != null && session.stopped_by_restart === 1).map(({ id }) => id);
    return {
      id: row.id,
      zoneId: row.zone_id,
      position: tilePosition(row),
      name: row.name,
      cwd: row.cwd,
      layout,
      paneFolders: Object.fromEntries(panes.map(({ id, session }) => [id, session?.last_cwd ?? session?.cwd ?? row.cwd])),
      endedPanes,
      stoppedPanes,
      createdAt: row.created_at,
    };
  };

  const get = (id: string): Shell => {
    const row = selectOne.get(id) as ShellRow | undefined;
    if (row === undefined) throw invalidParams(`no shell ${id}`);
    return toShell(row);
  };

  /** Every shell it can read. A row whose layout doesn't parse (say, one a later version wrote) is logged and left out. */
  const readable = (rows: ShellRow[]): Shell[] =>
    rows.flatMap((row) => {
      try {
        return [toShell(row)];
      } catch (error) {
        log(`skipping shell ${row.id}: its layout can't be read: ${(error as Error).message}`);
        return [];
      }
    });

  const all = (): Shell[] => readable(selectAll.all() as unknown as ShellRow[]);

  /** The lowest `Shell N` no shell in the zone (or, for null, loose on the board) is called. */
  const freeName = (zoneId: string | null): string => {
    const taken = new Set((namesInZone.all(zoneId) as unknown as { name: string }[]).map((row) => row.name));
    let n = 1;
    while (taken.has(`Shell ${n}`)) n += 1;
    return `Shell ${n}`;
  };

  const announce = (shell: Shell): Shell => {
    broadcast({ type: 'shell.updated', shell });
    return shell;
  };

  const save = (id: string, layout: PaneLayout): Shell => {
    updateLayout.run(JSON.stringify(layout), id);
    return announce(get(id));
  };

  const newPane = (cwd: string, zoneId: string | null): SessionInfo => sessions.createShell({ ...INITIAL_SIZE, cwd, zoneId });

  /** Where a shell made in the zone starts: its folder, or an unbound zone's default repo, else home. */
  const folderOf = (zoneId: string | null): string => {
    if (zoneId === null) return homeDir;
    const zone = selectZone.get(zoneId) as ZoneFolder | undefined;
    if (zone === undefined) throw invalidParams(`no zone ${zoneId}`);
    // An unbound zone has no folder of its own, so its shells start in its default repo, else at home; binding it later
    // doesn't move them.
    if (zone.repo_root === null) return zone.default_repo ?? homeDir;
    return folderPath(zone.repo_root, zone.folder);
  };

  /** A new shell tile around the live pane `pane`, named in its zone. Synchronous, so two can't pick the same name. */
  const insertShell = (pane: SessionInfo, zoneId: string | null, cwd: string, place: { x: number; y: number } | undefined): string => {
    const id = randomUUID();
    const layout = JSON.stringify({ type: 'pane', sessionId: pane.id } satisfies PaneLayout);
    insert.run(id, zoneId, freeName(zoneId), cwd, layout, place?.x ?? null, place?.y ?? null, place === undefined ? null : frontZ(db));
    return id;
  };

  /** Ends the session if it is still live, and forgets its output: nothing will show the pane again. */
  const endPane = async (sessionId: string): Promise<void> => {
    if (sessions.list().some((session) => session.id === sessionId)) await sessions.kill(sessionId);
    sessions.forget(sessionId);
  };

  /** Tells clients about the shell the session is a pane of, if any. */
  const announcePane = (sessionId: string) => {
    const rows = selectWithPane.all(`%"sessionId":"${sessionId}"%`) as unknown as ShellRow[];
    for (const shell of readable(rows)) if (paneIds(shell.layout).includes(sessionId)) announce(shell);
  };

  return {
    list: () => all(),
    move(shellId, move) {
      const shell = get(shellId);
      if (move.zoneId !== null && selectZone.get(move.zoneId) === undefined) throw invalidParams(`no zone ${move.zoneId}`);
      saveMove(db, updatePlace, shellId, shell.position, move);
      return announce(get(shellId));
    },
    handlers: () => ({
      'shell.list': () => all(),
      'shell.create': (raw) => {
        const fields = paramsObject(raw);
        const zoneId = zoneIdParam(fields);
        const place = optionalPlaceParam(fields);
        if (zoneId === null && place === undefined) throw invalidParams('a loose shell needs a position');
        const cwd = folderOf(zoneId);
        const pane = newPane(cwd, zoneId);
        try {
          return announce(get(insertShell(pane, zoneId, cwd, place)));
        } catch (error) {
          void sessions.kill(pane.id);
          throw error;
        }
      },
      'shell.move': (raw) => {
        const fields = paramsObject(raw);
        const shellId = stringParam(fields, 'shellId');
        const move = moveParams(fields);
        return queue(shellId, async () => {
          const shell = get(shellId);
          if (move.zoneId !== null && selectZone.get(move.zoneId) === undefined) throw invalidParams(`no zone ${move.zoneId}`);
          saveMove(db, updatePlace, shellId, shell.position, move);
          return announce(get(shellId));
        });
      },
      'shell.setName': (raw) => {
        const fields = paramsObject(raw);
        const shellId = stringParam(fields, 'shellId');
        const name = requiredNameParam(fields, 'name');
        return queue(shellId, async () => {
          get(shellId);
          updateName.run(name, shellId);
          return announce(get(shellId));
        });
      },
      'shell.setPaneName': (raw) => {
        const fields = paramsObject(raw);
        const shellId = stringParam(fields, 'shellId');
        const sessionId = stringParam(fields, 'sessionId');
        const name = fields.name === null ? '' : nameParam(fields, 'name');
        return queue(shellId, async () => {
          const shell = get(shellId);
          if (!paneIds(shell.layout).includes(sessionId)) throw invalidParams(`no pane ${sessionId} in shell ${shellId}`);
          return save(shellId, setPaneName(shell.layout, sessionId, name));
        });
      },
      'shell.split': (raw) => {
        const fields = paramsObject(raw);
        const shellId = stringParam(fields, 'shellId');
        const sessionId = stringParam(fields, 'sessionId');
        const direction = directionParam(fields);
        const cwd = optionalStringParam(fields, 'cwd');
        if (cwd !== undefined && !isAbsolute(cwd)) throw invalidParams(`cwd must be absolute, got ${cwd}`);
        if (cwd !== undefined && !isDirectory(cwd)) throw invalidParams(`${cwd} is not a folder`);
        return queue(shellId, async () => {
          const shell = get(shellId);
          if (!paneIds(shell.layout).includes(sessionId)) throw invalidParams(`no pane ${sessionId} in shell ${shellId}`);
          const pane = newPane(cwd ?? shell.cwd, shell.zoneId);
          try {
            return save(shellId, splitPane(shell.layout, sessionId, direction, pane.id, randomUUID()));
          } catch (error) {
            void sessions.kill(pane.id);
            throw error;
          }
        });
      },
      'shell.resizeSplit': (raw) => {
        const fields = paramsObject(raw);
        const shellId = stringParam(fields, 'shellId');
        const splitId = stringParam(fields, 'splitId');
        const ratio = fields.ratio;
        if (typeof ratio !== 'number' || !Number.isFinite(ratio)) throw invalidParams('ratio must be a finite number');
        return queue(shellId, async () => {
          const shell = get(shellId);
          try {
            return save(shellId, setSplitRatio(shell.layout, splitId, ratio));
          } catch (error) {
            throw invalidParams((error as Error).message);
          }
        });
      },
      'shell.resumePane': (raw) => {
        const fields = paramsObject(raw);
        const shellId = stringParam(fields, 'shellId');
        const sessionId = stringParam(fields, 'sessionId');
        return queue(shellId, async () => {
          const shell = get(shellId);
          if (!paneIds(shell.layout).includes(sessionId)) throw invalidParams(`no pane ${sessionId} in shell ${shellId}`);
          if (!shell.endedPanes.includes(sessionId)) throw invalidParams('that pane is still running');
          // Its exit is told before it has finished: wait for that, or there is no starting it again yet.
          await sessions.kill(sessionId).catch(() => {});
          // Where its shell last was, else where the tile's shells start, else home: a folder may have gone since.
          const lastCwd = (paneSession.get(sessionId) as PaneSession | undefined)?.last_cwd ?? null;
          const cwd = [lastCwd, shell.cwd].find((folder) => folder !== null && isDirectory(folder)) ?? homeDir;
          const saved = sessions.savedScreen(sessionId);
          // Only a pane a restart stopped says so; one whose shell exited carries on under its old output.
          const marker = shell.stoppedPanes.includes(sessionId) ? `${RESTORED_MARKER}\r\n` : '';
          const restore = `${saved === undefined ? '' : `${saved.data}${RESET_MODES}\r\n`}${marker}`;
          // Laid out as it was saved, so wide output doesn't wrap until the window sizes the pane.
          const size = saved === undefined ? INITIAL_SIZE : { cols: saved.cols, rows: saved.rows };
          sessions.createShell({ ...size, cwd, id: sessionId, restore, zoneId: shell.zoneId });
          log(`resumed pane ${sessionId} of shell ${shellId} in ${cwd}`);
          return announce(get(shellId));
        });
      },
      'shell.closePane': (raw) => {
        const fields = paramsObject(raw);
        const shellId = stringParam(fields, 'shellId');
        const sessionId = stringParam(fields, 'sessionId');
        return queue(shellId, async () => {
          if (!paneIds(get(shellId).layout).includes(sessionId)) throw invalidParams(`no pane ${sessionId} in shell ${shellId}`);
          await endPane(sessionId);
          const rest = removePane(get(shellId).layout, sessionId);
          if (rest !== null) return save(shellId, rest);
          remove.run(shellId);
          broadcast({ type: 'shell.removed', shellId });
          return null;
        });
      },
      'shell.delete': (raw) => {
        const shellId = stringParam(paramsObject(raw), 'shellId');
        return queue(shellId, async () => {
          const shell = get(shellId);
          await Promise.all(paneIds(shell.layout).map(endPane));
          remove.run(shellId);
          broadcast({ type: 'shell.removed', shellId });
          return null;
        });
      },
    }),

    adopt(session) {
      announce(get(insertShell(session, null, session.cwd, undefined)));
    },

    onSessionExit: (session) => announcePane(session.id),
    onPaneFolder: (sessionId) => announcePane(sessionId),
  };
}

interface PaneSession {
  ended_at: string | null;
  stopped_by_restart: number;
  last_cwd: string | null;
  /** Where its shell started. */
  cwd: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether any shell tile lives in the zone. */
export function zoneHasShells(db: DatabaseSync, zoneId: string): boolean {
  return (db.prepare('SELECT count(*) AS n FROM shells WHERE zone_id = ?').get(zoneId) as { n: number }).n > 0;
}

function directionParam(fields: Record<string, unknown>): SplitDirection {
  const direction = fields.direction;
  if (direction !== 'horizontal' && direction !== 'vertical') throw invalidParams('direction must be "horizontal" or "vertical"');
  return direction;
}
