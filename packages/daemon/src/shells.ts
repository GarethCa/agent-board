import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { keyedQueue } from './keyed-queue.ts';
import { invalidParams, nameParam, optionalStringParam, paramsObject, requiredNameParam, stringParam } from './params.ts';
import { paneIds, paneName, parsePaneLayout, removePane, setPaneName, setSplitRatio, splitPane, type PaneLayout, type SplitDirection } from './pane-layout.ts';
import { packageScripts, scriptCommand } from './package-scripts.ts';
import { paneOfSurface, paneSplitInto, parseWindowLayout, singlePane, surfaceKey, type Surface, type WindowLayout } from './window-layout.ts';
import { isOwnedBy, isOwnTab, type DaemonEvent, type DaemonMethods, type SessionInfo, type Shell, type ShellOwner, type ShellPlace, type TileMove } from './protocol.ts';
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
  owner_kind: ShellOwner['kind'] | null;
  owner_id: string | null;
  tab_order: number | null;
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
  /** Tells clients about the shell the session is a pane of, if any: the pane's shell is in another folder, or its `shellState` changed. */
  onPaneChanged(sessionId: string): void;
  /** Ends every tab of the agent's and removes them, its own tab too: the agent is being deleted. */
  deleteOwned(agentId: string): Promise<void>;
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
  /** The shell a pane runs (`/bin/zsh`): a new shell tab is named after it. */
  shell: string;
  /**
   * Whether the agent is being deleted, its own mark: its tabs end early in its delete and its worktree goes
   * after, so a tab moved or opened in meanwhile would outlive it, running in no window.
   */
  agentDeleting(agentId: string): boolean;
  broadcast(event: DaemonEvent): void;
  log(message: string): void;
}): ShellHost {
  const { db, sessions, homeDir, broadcast, log } = options;
  const tabName = basename(options.shell) || 'shell';
  const selectAll = db.prepare('SELECT * FROM shells ORDER BY rowid');
  const selectOne = db.prepare('SELECT * FROM shells WHERE id = ?');
  const selectZone = db.prepare('SELECT repo_root, folder, default_repo FROM zones WHERE id = ?');
  // A tab has no zone, so shells loose on the board are those with no owner either.
  const namesInZone = db.prepare('SELECT name FROM shells WHERE zone_id IS ? AND owner_id IS NULL');
  // A tab made before tabs could move has no order, and sorts first, in the order it was made.
  const selectOwned = db.prepare('SELECT * FROM shells WHERE owner_kind = ? AND owner_id = ? ORDER BY tab_order, rowid');
  const selectAgent = db.prepare(
    'SELECT a.session_id, s.cwd FROM agents a JOIN sessions s ON s.id = a.session_id WHERE a.session_id = ?',
  );
  // A pane's session ID is a UUID, so it has no LIKE wildcards; the layout is stored as JSON.stringify writes it.
  const selectWithPane = db.prepare('SELECT * FROM shells WHERE layout LIKE ? ORDER BY rowid');
  const insert = db.prepare('INSERT INTO shells (id, zone_id, name, cwd, layout, x, y, z) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertTab = db.prepare('INSERT INTO shells (id, zone_id, name, cwd, layout, owner_kind, owner_id, tab_order) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)');
  const updateHome = db.prepare('UPDATE shells SET owner_kind = ?, owner_id = ?, tab_order = ?, zone_id = ?, x = ?, y = ?, z = ? WHERE id = ?');
  const selectLastOrder = db.prepare('SELECT max(tab_order) AS last FROM shells');
  const updateName = db.prepare('UPDATE shells SET name = ? WHERE id = ?');
  const updateLayout = db.prepare('UPDATE shells SET layout = ? WHERE id = ?');
  const updatePlace = db.prepare('UPDATE shells SET zone_id = ?, x = ?, y = ?, z = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM shells WHERE id = ?');
  const paneSession = db.prepare('SELECT cwd, ended_at, exit_code, stopped_by_restart, last_cwd FROM sessions WHERE id = ?');
  const selectWindow = db.prepare('SELECT layout FROM window_layouts WHERE owner_kind = ? AND owner_id = ?');
  const upsertWindow = db.prepare(
    'INSERT INTO window_layouts (owner_kind, owner_id, layout) VALUES (?, ?, ?) ON CONFLICT (owner_kind, owner_id) DO UPDATE SET layout = excluded.layout',
  );
  const deleteWindow = db.prepare('DELETE FROM window_layouts WHERE owner_kind = ? AND owner_id = ?');
  const queue = keyedQueue();
  /** The shell tiles being deleted, by `ownerKey`: none takes a new tab meanwhile, which would outlive it. */
  const deleting = new Set<string>();
  /** Whether the owner is being deleted: an agent by its own mark, a shell tile by this host's. */
  const going = (owner: ShellOwner) => (owner.kind === 'agent' ? options.agentDeleting(owner.id) : deleting.has(ownerKey(owner)));

  const toShell = (row: ShellRow): Shell => {
    const layout = parsePaneLayout(JSON.parse(row.layout));
    const owner: ShellOwner | null = row.owner_kind === null || row.owner_id === null ? null : { kind: row.owner_kind, id: row.owner_id };
    const panes = paneIds(layout).map((id) => ({ id, session: paneSession.get(id) as PaneSession | undefined }));
    // The agent's own pane in its tab is the agent's to tell of: never an ended, stopped or busy shell.
    const shellPanes = panes.filter(({ id }) => id !== owner?.id);
    const ended = shellPanes.filter(({ session }) => session === undefined || session.ended_at !== null);
    const endedPanes = ended.map(({ id }) => id);
    const live = shellPanes.filter((pane) => !ended.includes(pane)).map(({ id }) => ({ id, state: sessions.shellState(id) }));
    const stoppedPanes = ended.filter(({ session }) => session?.stopped_by_restart === 1).map(({ id }) => id);
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
      exitCodes: Object.fromEntries(ended.map(({ id, session }) => [id, session?.exit_code ?? null])),
      busyPanes: live.filter(({ state }) => state.busy).map(({ id }) => id),
      panePorts: Object.fromEntries(live.filter(({ state }) => state.busy && state.ports.length > 0).map(({ id, state }) => [id, state.ports])),
      failedCommands: Object.fromEntries(live.flatMap(({ id, state }) => (state.lastStatus ? [[id, state.lastStatus]] : []))),
      owner,
      tabOrder: row.tab_order,
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

  /** `base`, or `base 2`, `base 3`…: the first none of the owner's shell tabs is called (an agent's own tab doesn't count). */
  const freeTabName = (owner: ShellOwner, base: string): string => {
    const taken = new Set(ownedBy(owner).filter((shell) => !isOwnTab(shell)).map((shell) => shell.name));
    let n = 1;
    while (taken.has(n === 1 ? base : `${base} ${n}`)) n += 1;
    return n === 1 ? base : `${base} ${n}`;
  };

  const agentOf = (agentId: string): AgentRow => {
    const agent = selectAgent.get(agentId) as AgentRow | undefined;
    if (agent === undefined) throw invalidParams(`no agent ${agentId}`);
    return agent;
  };

  const ownedBy = (owner: ShellOwner): Shell[] => readable(selectOwned.all(owner.kind, owner.id) as unknown as ShellRow[]);

  const ownTabOf = (agentId: string): Shell | undefined => ownedBy({ kind: 'agent', id: agentId }).find(isOwnTab);

  /**
   * Where the owner's new tabs start, and the zone their shells are told they are in: where the agent started (its
   * tabs' shells get no zone), or the shell tile's folder and zone. Fails for an unknown owner, or a shell that is a tab.
   */
  const ownerFolder = (owner: ShellOwner): { cwd: string; zoneId: string | null } => {
    if (going(owner)) throw invalidParams(`${owner.kind} ${owner.id} is being deleted`);
    if (owner.kind === 'agent') return { cwd: agentOf(owner.id).cwd, zoneId: null };
    const tile = get(owner.id);
    tileOnly(tile);
    return { cwd: tile.cwd, zoneId: tile.zoneId };
  };

  /** The zone the shell's panes are told they are in: a tile's own, a shell tile's for its tabs, none for an agent's. */
  const paneZone = (shell: Shell): string | null => {
    if (shell.owner?.kind !== 'shell') return shell.zoneId;
    return (selectOne.get(shell.owner.id) as ShellRow | undefined)?.zone_id ?? null;
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

  /** The order that puts a tab after every other, of any owner's. */
  const nextOrder = (): number => ((selectLastOrder.get() as { last: number | null }).last ?? 0) + 1;

  /** A new tab of the owner's, after its others, holding `layout`, named `name`. */
  const insertOwned = (owner: ShellOwner, name: string, cwd: string, layout: PaneLayout, id: string = randomUUID()): string => {
    insertTab.run(id, name, cwd, JSON.stringify(layout), owner.kind, owner.id, nextOrder());
    return id;
  };

  /** Runs `change` in one transaction. */
  const atomically = <T>(change: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = change();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  /** Fails for a shell that is being deleted, or is a tab of an owner that is: it is going. */
  const notGoing = (shell: Shell) => {
    if (deleting.has(ownerKey({ kind: 'shell', id: shell.id })) || (shell.owner !== null && going(shell.owner))) {
      throw invalidParams(`shell ${shell.id} is being deleted`);
    }
  };

  /**
   * Fails for a place `moving` (or a pane of it) can't go to: an owner unknown, a tab, being deleted, or (unless
   * `ownOk`, for a pane, which may become a tab of its own shell tile) `moving` itself; or an unknown zone.
   */
  const checkPlace = (to: ShellPlace, moving: Shell, ownOk = false) => {
    if ('tile' in to) {
      if (to.tile.zoneId !== null && selectZone.get(to.tile.zoneId) === undefined) throw invalidParams(`no zone ${to.tile.zoneId}`);
      return;
    }
    if (!ownOk && to.owner.kind === 'shell' && to.owner.id === moving.id) throw invalidParams(`shell ${moving.id} can't be a tab of its own`);
    ownerFolder(to.owner);
  };

  /** Puts the shell `id` at `to`: a tab of the owner's, at `order` (else after its others), or a shell tile on the board. */
  const placeShell = (id: string, from: Shell['position'], to: ShellPlace, order?: number | null) => {
    if ('owner' in to) {
      updateHome.run(to.owner.kind, to.owner.id, order === undefined ? nextOrder() : order, null, null, null, null, id);
      return;
    }
    const { zoneId, x, y } = to.tile;
    const z = to.tile.toFront === true ? frontZ(db) : (to.tile.z ?? from?.z ?? null);
    // Off the board it has no order; it keeps the one it had, for an undo to find its place again.
    updateHome.run(null, null, (selectOne.get(id) as unknown as ShellRow).tab_order, zoneId, x, y, z, id);
  };

  /** Fails for a shell that is a tab: it has no tile to move, nor tabs of its own. */
  const tileOnly = (shell: Shell) => {
    if (shell.owner !== null) throw invalidParams(`shell ${shell.id} is a tab of ${shell.owner.kind} ${shell.owner.id}: a tab has no tile`);
  };

  /**
   * Moves the pane out of the shell's split into a new shell `id` at `to`, named after the pane's label, else the
   * shell's; its process untouched. In the shell's turn.
   */
  const movePaneOut = (shell: Shell, sessionId: string, to: ShellPlace, id: string): { moved: Shell; source: Shell } => {
    if (!paneIds(shell.layout).includes(sessionId)) throw invalidParams(`no pane ${sessionId} in shell ${shell.id}`);
    notTheAgent(shell, sessionId);
    notGoing(shell);
    const rest = removePane(shell.layout, sessionId);
    if (rest === null) throw invalidParams(`${sessionId} is the only pane of shell ${shell.id}: move the shell instead`);
    if (selectOne.get(id) !== undefined) throw invalidParams(`shell ${id} already exists`);
    // A pane may become a tab of the shell tile it is in.
    checkPlace(to, shell, true);
    const name = paneName(shell.layout, sessionId) ?? shell.name;
    const cwd = shell.paneFolders[sessionId] ?? shell.cwd;
    const pane: PaneLayout = { type: 'pane', sessionId };
    atomically(() => {
      updateLayout.run(JSON.stringify(rest), shell.id);
      if ('owner' in to) insertOwned(to.owner, name, cwd, pane, id);
      else insert.run(id, to.tile.zoneId, name, cwd, JSON.stringify(pane), to.tile.x, to.tile.y, to.tile.z ?? frontZ(db));
    });
    log(`moved pane ${sessionId} of shell ${shell.id} to ${placeText(to)} as shell ${id}`);
    return { moved: announce(get(id)), source: announce(get(shell.id)) };
  };

  /** The owner's window layout as kept, or null for none (or one that can't be read, which is logged). */
  const readWindow = (owner: ShellOwner): WindowLayout | null => {
    const row = selectWindow.get(owner.kind, owner.id) as { layout: string } | undefined;
    if (row === undefined) return null;
    try {
      return parseWindowLayout(JSON.parse(row.layout));
    } catch (error) {
      // One a later version wrote, say: the window starts over from its tabs.
      log(`ignoring the window layout of ${owner.kind} ${owner.id}: ${(error as Error).message}`);
      return null;
    }
  };

  /** Ends the shell's panes, but an agent's own pane in its own tab, and removes it. */
  const removeShell = async (tab: Shell): Promise<void> => {
    await Promise.all(paneIds(tab.layout).filter((id) => id !== tab.owner?.id).map(endPane));
    remove.run(tab.id);
    broadcast({ type: 'shell.removed', shellId: tab.id });
  };

  /**
   * Moves the shell tile's next tab's panes into its own row, as its first tab, and removes the tab's row; the tab
   * moved, if it had one. The tile keeps its folder, where its new tabs and splits start. Each tab is read again in its own turn, so
   * one closed meanwhile is passed over.
   */
  const promoteNextTab = async (tileId: string): Promise<string | undefined> => {
    for (const next of ownedBy({ kind: 'shell', id: tileId })) {
      const moved = await queue(next.id, async () => {
        const row = selectOne.get(next.id) as ShellRow | undefined;
        if (row === undefined) return false;
        db.exec('BEGIN IMMEDIATE');
        try {
          updateLayout.run(row.layout, tileId);
          remove.run(next.id);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        broadcast({ type: 'shell.removed', shellId: next.id });
        return true;
      });
      if (moved) return next.id;
    }
    return undefined;
  };

  /**
   * Ends and removes every tab of the owner's, each in its turn (one moved to another meanwhile is passed over), and
   * forgets how its window laid them out.
   */
  const removeOwned = async (owner: ShellOwner): Promise<void> => {
    for (const tab of ownedBy(owner)) {
      await queue(tab.id, async () => {
        const row = selectOne.get(tab.id) as ShellRow | undefined;
        if (row !== undefined && row.owner_kind === owner.kind && row.owner_id === owner.id) await removeShell(toShell(row));
      });
    }
    deleteWindow.run(owner.kind, owner.id);
  };

  /** Fails for the agent's own pane in its tab: that is the agent, which only Stop or Delete ends. */
  const notTheAgent = (shell: Shell, sessionId: string) => {
    if (shell.owner !== null && sessionId === shell.owner.id) throw invalidParams(`${sessionId} is the agent's own pane: stop or delete the agent instead`);
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
      tileOnly(shell);
      if (move.zoneId !== null && selectZone.get(move.zoneId) === undefined) throw invalidParams(`no zone ${move.zoneId}`);
      saveMove(db, updatePlace, shellId, shell.position, move);
      return announce(get(shellId));
    },
    handlers: () => ({
      'shell.list': () => all(),
      'shell.createTab': (raw) => {
        const fields = paramsObject(raw);
        const owner = ownerParam(fields);
        const cwd = optionalStringParam(fields, 'cwd');
        const script = optionalStringParam(fields, 'script');
        if (cwd !== undefined && !isAbsolute(cwd)) throw invalidParams(`cwd must be absolute, got ${cwd}`);
        if (cwd !== undefined && !isDirectory(cwd)) throw invalidParams(`${cwd} is not a folder`);
        const from = ownerFolder(owner);
        const folder = cwd ?? from.cwd;
        const scripts = script === undefined ? undefined : packageScripts(folder);
        if (script !== undefined && !scripts!.scripts.includes(script)) throw invalidParams(`no script ${script} in ${folder}/package.json`);
        const pane = newPane(folder, from.zoneId);
        try {
          const name = freeTabName(owner, script === undefined ? tabName : `${scripts!.runner} ${script}`);
          const tab = announce(get(insertOwned(owner, name, folder, { type: 'pane', sessionId: pane.id })));
          if (script !== undefined) sessions.write(pane.id, `${scriptCommand(scripts!.runner, script)}\r`);
          return tab;
        } catch (error) {
          void sessions.kill(pane.id);
          throw error;
        }
      },
      'shell.ownTab': (raw) => {
        const agentId = stringParam(paramsObject(raw), 'agentId');
        return queue(`own:${agentId}`, async () => {
          const agent = agentOf(agentId);
          // Named after the shell, which its shell panes go by until labelled; the tab strip calls it after its panes.
          return ownTabOf(agentId) ?? announce(get(insertOwned({ kind: 'agent', id: agentId }, tabName, agent.cwd, { type: 'pane', sessionId: agentId })));
        });
      },
      'shell.scripts': (raw) => packageScripts(ownerFolder(ownerParam(paramsObject(raw))).cwd),
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
          tileOnly(shell);
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
          const pane = newPane(cwd ?? shell.cwd, paneZone(shell));
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
          notTheAgent(shell, sessionId);
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
          sessions.createShell({ ...size, cwd, id: sessionId, restore, zoneId: paneZone(shell) });
          log(`resumed pane ${sessionId} of shell ${shellId} in ${cwd}`);
          return announce(get(shellId));
        });
      },
      'shell.closePane': (raw) => {
        const fields = paramsObject(raw);
        const shellId = stringParam(fields, 'shellId');
        const sessionId = stringParam(fields, 'sessionId');
        return queue(shellId, async () => {
          const shell = get(shellId);
          if (!paneIds(shell.layout).includes(sessionId)) throw invalidParams(`no pane ${sessionId} in shell ${shellId}`);
          notTheAgent(shell, sessionId);
          await endPane(sessionId);
          const rest = removePane(get(shellId).layout, sessionId);
          if (rest !== null) return save(shellId, rest);
          // A shell tile's first tab is its own layout: with more tabs, the next takes its place, and the tile stays.
          if (shell.owner === null && (await promoteNextTab(shellId)) !== undefined) return announce(get(shellId));
          remove.run(shellId);
          broadcast({ type: 'shell.removed', shellId });
          return null;
        });
      },
      'shell.closeOwnPanes': (raw) => {
        const shellId = stringParam(paramsObject(raw), 'shellId');
        return queue(shellId, async () => {
          const tile = get(shellId);
          tileOnly(tile);
          notGoing(tile);
          // Its next tab takes its place first, so a tab moved away meanwhile can't leave a tile with no panes.
          const promoted = await promoteNextTab(shellId);
          if (promoted === undefined) throw invalidParams(`shell ${shellId} has no other tab to take its panes' place: delete it instead`);
          await Promise.all(paneIds(tile.layout).map(endPane));
          log(`closed the panes of shell ${shellId}; its tab ${promoted} took their place`);
          return { tile: announce(get(shellId)), promoted };
        });
      },
      'shell.delete': (raw) => {
        const shellId = stringParam(paramsObject(raw), 'shellId');
        // Marked at once, before its turn comes: a tab asked for after this would outlive the tile.
        const tile = (selectOne.get(shellId) as ShellRow | undefined)?.owner_id === null;
        const key = ownerKey({ kind: 'shell', id: shellId });
        if (tile) deleting.add(key);
        return queue(shellId, async () => {
          const shell = get(shellId);
          if (isOwnTab(shell)) throw invalidParams("the agent's own tab can't be closed");
          // A shell tile's tabs go with it.
          if (shell.owner === null) await removeOwned({ kind: 'shell', id: shellId });
          await removeShell(shell);
          return null;
        }).finally(() => {
          if (tile) deleting.delete(key);
        });
      },
      'shell.moveTab': (raw) => {
        const fields = paramsObject(raw);
        const shellId = stringParam(fields, 'shellId');
        const to = placeParam(fields);
        const order = orderParam(fields);
        return queue(shellId, async () => {
          const shell = get(shellId);
          if (isOwnTab(shell)) throw invalidParams("the agent's own tab stays with its agent");
          notGoing(shell);
          checkPlace(to, shell);
          if ('owner' in to && isOwnedBy(shell, to.owner)) return [shell];
          // A tab's owner is always a tile or an agent, never a tab: a shell tile's tabs go with it, after it.
          const tabs = 'owner' in to && shell.owner === null ? ownedBy({ kind: 'shell', id: shellId }) : [];
          atomically(() => {
            placeShell(shellId, shell.position, to, order);
            for (const tab of tabs) placeShell(tab.id, null, to);
          });
          log(`moved shell ${shellId}${tabs.length === 0 ? '' : ` and its ${tabs.length} tabs`} to ${placeText(to)}`);
          return [shell, ...tabs].map((moved) => announce(get(moved.id)));
        });
      },
      'shell.movePane': (raw) => {
        const fields = paramsObject(raw);
        const shellId = stringParam(fields, 'shellId');
        const sessionId = stringParam(fields, 'sessionId');
        const to = placeParam(fields);
        const id = optionalStringParam(fields, 'id') ?? randomUUID();
        return queue(shellId, async () => {
          const shell = get(shellId);
          return { ...movePaneOut(shell, sessionId, to, id), layoutBefore: shell.layout };
        });
      },
      'shell.returnPane': (raw) => {
        const fields = paramsObject(raw);
        const shellId = stringParam(fields, 'shellId');
        const sessionId = stringParam(fields, 'sessionId');
        let layout: PaneLayout;
        try {
          layout = parsePaneLayout(fields.layout);
        } catch (error) {
          throw invalidParams(`layout: ${(error as Error).message}`);
        }
        const holderOf = () => all().find((candidate) => candidate.id !== shellId && paneIds(candidate.layout).includes(sessionId));
        const first = holderOf();
        if (first === undefined) throw invalidParams(`${sessionId} is not alone in a shell of its own`);
        // In both shells' turns: a close or delete of the pane's own shell under way finishes first, and is seen.
        return queue(shellId, () =>
          queue(first.id, async () => {
            const shell = get(shellId);
            notGoing(shell);
            const holder = holderOf();
            if (holder?.id !== first.id || paneIds(holder.layout).length !== 1) throw invalidParams(`${sessionId} is not alone in a shell of its own`);
            if (isOwnTab(holder)) throw invalidParams(`${sessionId} is the agent's own pane`);
            notGoing(holder);
            if (holder.owner === null && ownedBy({ kind: 'shell', id: holder.id }).length > 0) throw invalidParams(`shell ${holder.id} has tabs of its own`);
            const want = [...paneIds(shell.layout), sessionId].sort();
            if (JSON.stringify(paneIds(layout).sort()) !== JSON.stringify(want)) throw invalidParams(`layout must hold the panes of shell ${shellId} and ${sessionId}`);
            atomically(() => {
              updateLayout.run(JSON.stringify(layout), shellId);
              remove.run(holder.id);
            });
            broadcast({ type: 'shell.removed', shellId: holder.id });
            log(`returned pane ${sessionId} to shell ${shellId}`);
            return announce(get(shellId));
          }),
        );
      },
      'shell.windowLayout': (raw) => readWindow(ownerParam(paramsObject(raw))),
      'shell.unsplitTabs': (raw) => {
        const owner = ownerParam(paramsObject(raw));
        return queue(windowQueue(owner), async () => {
          ownerFolder(owner);
          let layout = readWindow(owner);
          for (const tab of ownedBy(owner).filter((shell) => paneIds(shell.layout).length > 1)) {
            // Each in the tab's turn, read again: one closed or moved meanwhile is passed over.
            layout = await queue(tab.id, async () => {
              const row = selectOne.get(tab.id) as ShellRow | undefined;
              if (row === undefined || row.owner_kind !== owner.kind || row.owner_id !== owner.id) return layout;
              const shell = toShell(row);
              const kept = isOwnTab(shell) ? owner.id : paneIds(shell.layout)[0]!;
              const rows = new Map<string, string>(paneIds(shell.layout).filter((id) => id !== kept).map((sessionId) => [sessionId, randomUUID()]));
              for (const [sessionId, id] of rows) movePaneOut(get(shell.id), sessionId, { owner }, id);
              // Laid out from the tabs as they were, before panes, when the window kept none.
              const made = new Set(rows.values());
              const strip = ownedBy(owner).filter((each) => !isOwnTab(each) && !made.has(each.id));
              const current = layout ?? singlePane([{ kind: 'own' }, ...strip.map((each): Surface => ({ kind: 'shell', shellId: each.id }))]);
              const holder = paneOfSurface(current, surfaceKey(isOwnTab(shell) ? { kind: 'own' } : { kind: 'shell', shellId: shell.id }));
              if (holder === undefined) return current;
              return paneSplitInto(current, holder.id, shell.layout, kept, (sessionId) => ({ kind: 'shell', shellId: rows.get(sessionId)! }), randomUUID);
            });
          }
          if (layout !== null) upsertWindow.run(owner.kind, owner.id, JSON.stringify(layout));
          return { layout, tabs: ownedBy(owner) };
        });
      },
      'shell.setWindowLayout': (raw) => {
        const fields = paramsObject(raw);
        const owner = ownerParam(fields);
        let layout: WindowLayout;
        try {
          layout = parseWindowLayout(fields.layout);
        } catch (error) {
          throw invalidParams(`layout: ${(error as Error).message}`);
        }
        // In the owner's window's turn, and refused for an owner on its way out.
        return queue(windowQueue(owner), async () => {
          ownerFolder(owner);
          upsertWindow.run(owner.kind, owner.id, JSON.stringify(layout));
          return layout;
        });
      },
    }),

    adopt(session) {
      announce(get(insertShell(session, null, session.cwd, undefined)));
    },

    onSessionExit: (session) => announcePane(session.id),
    onPaneChanged: (sessionId) => announcePane(sessionId),

    deleteOwned: (agentId) => removeOwned({ kind: 'agent', id: agentId }),
  };
}

interface AgentRow {
  session_id: string;
  /** Where the agent started: its worktree, or its zone's folder in it. */
  cwd: string;
}

interface PaneSession {
  ended_at: string | null;
  exit_code: number | null;
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

/** The queue a window's layout is changed in. */
const windowQueue = (owner: ShellOwner) => `window:${owner.kind}:${owner.id}`;

/** The key the owner is marked by while it is being deleted. */
const ownerKey = (owner: ShellOwner) => `${owner.kind}:${owner.id}`;

/** Where a place is, for the log. */
const placeText = (to: ShellPlace) => ('owner' in to ? `${to.owner.kind} ${to.owner.id}` : `the board (zone ${to.tile.zoneId ?? 'none'})`);

/** A move's `to`: `{ owner }`, or `{ tile }` with a place as `shell.move` takes one. */
function placeParam(fields: Record<string, unknown>): ShellPlace {
  const to = fields.to;
  if (typeof to !== 'object' || to === null) throw invalidParams('to must be an object');
  if ('owner' in to) return { owner: ownerParam(to as Record<string, unknown>) };
  if ('tile' in to) return { tile: moveParams(paramsObject((to as Record<string, unknown>).tile)) };
  throw invalidParams('to must have an owner or a tile');
}

/** A move's optional `order`: a finite number, or null. */
function orderParam(fields: Record<string, unknown>): number | null | undefined {
  const order = fields.order;
  if (order === undefined || order === null) return order;
  if (typeof order !== 'number' || !Number.isFinite(order)) throw invalidParams('order must be a finite number or null');
  return order;
}

function ownerParam(fields: Record<string, unknown>): ShellOwner {
  const owner = fields.owner;
  if (typeof owner !== 'object' || owner === null) throw invalidParams('owner must be an object');
  const { kind, id } = owner as Record<string, unknown>;
  if (kind !== 'agent' && kind !== 'shell') throw invalidParams('owner.kind must be "agent" or "shell"');
  if (typeof id !== 'string') throw invalidParams('owner.id must be a string');
  return { kind, id };
}

function directionParam(fields: Record<string, unknown>): SplitDirection {
  const direction = fields.direction;
  if (direction !== 'horizontal' && direction !== 'vertical') throw invalidParams('direction must be "horizontal" or "vertical"');
  return direction;
}
