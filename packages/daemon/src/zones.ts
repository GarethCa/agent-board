import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { gateCommandArgv } from './gate-rules.ts';
import { runGit } from './git.ts';
import { keyedQueue } from './keyed-queue.ts';
import { folderPath } from './repo-zone.ts';
import { finiteNumberParam, invalidParams, optionalBooleanParam, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  DEFAULT_ZONE_SIZE,
  MIN_ZONE_SIZE,
  validZoneFillOpacity,
  ZONE_COLORS,
  type DaemonEvent,
  type DaemonMethods,
  type TrackerProvider,
  type Zone,
  type ZoneClone,
  type ZoneLayout,
  type ZoneTracker,
} from './protocol.ts';
import type { RpcHandlers, RpcMethodError } from './rpc.ts';
import { zoneHasShells } from './shells.ts';
import { zoneTrackerParam, type TrackerHost } from './trackers.ts';

type ZoneMethods = Pick<
  DaemonMethods,
  | 'zone.list'
  | 'zone.add'
  | 'zone.addUnbound'
  | 'zone.bind'
  | 'zone.unbind'
  | 'zone.setDefaultRepo'
  | 'zone.update'
  | 'zone.configure'
  | 'zone.setLook'
  | 'zone.setTracker'
  | 'zone.remove'
  | 'zone.restore'
>;

interface ZoneRow {
  id: string;
  /** Null while the zone is unbound. */
  repo_root: string | null;
  folder: string;
  name: string;
  color: string;
  fill_opacity: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  codex_bypass_hook_trust: number;
  board_mcp: number;
  agents_orchestrate: number;
  gate_command: string | null;
  tracker_provider: TrackerProvider | null;
  tracker_scope: string | null;
  tracker_project: string | null;
  clone_repo: string | null;
  clone_path: string | null;
  clone_made_folder: number | null;
  clone_made_owner: number | null;
  /** An unbound zone's default repo; null for none, and for a bound zone. */
  default_repo: string | null;
  created_at: string;
}

/** A zone to add, as `ZoneTable.insert` takes it. */
export interface NewZone extends ZoneLayout {
  /** Its id; made up if not given. */
  id?: string;
  repoRoot: string | null;
  folder: string;
  name: string;
  color: string;
  tracker: ZoneTracker | null;
  /** The clone it waits for, and which folders the daemon made for it, so a failed clone removes only those. */
  clone?: { repo: string; path: string; madeFolder: boolean; madeOwner: boolean };
}

/** Which folders the daemon made for a zone's clone. */
export interface CloneFolders {
  madeFolder: boolean;
  madeOwner: boolean;
}

/** Whether `path` is `<reposDir>/<owner>/<repo>`, where `zone.clone` clones a repo. */
function isManagedClonePath(reposDir: string, path: string): boolean {
  const inside = relative(reposDir, path);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) && inside.split(sep).length === 2;
}

/** A group's own folder (`Zone.groupFolder`), where its agents with no repo run: `<groupsDir>/<zone id>`. */
export function groupFolder(groupsDir: string, zoneId: string): string {
  return join(groupsDir, zoneId);
}

/** Whether `path` is a group's own folder, or in one: a plain folder the app made, outside git. */
export function inGroupFolder(groupsDir: string, path: string): boolean {
  const inside = relative(groupsDir, path);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
}

/** The `zones` table, shared by the `zone.*` handlers and the clones they start. */
export interface ZoneTable {
  get(id: string): Zone;
  /** Undefined for an unknown zone. */
  find(id: string): Zone | undefined;
  list(): Zone[];
  /** Adds the zone and announces it; for a bound one, remembers its folder as a recent one. */
  insert(zone: NewZone): Zone;
  /** Binds an unbound zone (one that is not cloning, unless `clone`), and remembers the folder. False if it is gone. */
  bind(id: string, repoRoot: string, folder: string, options?: { clone?: boolean }): boolean;
  /** Clears a zone's clone, leaving it unbound. */
  clearClone(id: string): void;
  /** Zones still waiting for a clone, as a daemon that went away left them. */
  cloning(): Zone[];
  /** Which folders the daemon made for the zone's clone; none for a zone that isn't cloning. */
  cloneFolders(id: string): CloneFolders;
  /** Deletes the zone, with no checks, and announces it. False if it was gone already. */
  remove(id: string, extra?: { cloneFailed?: string }): boolean;
  /** Whether agents' or shells' tiles are in it. */
  holdsSessions(id: string): boolean;
  announce(id: string, extra?: { cloneFailed?: string }): void;
  /** The least-used of `ZONE_COLORS`. */
  leastUsedColor(): string;
  /** Remembers a folder a zone was made for. */
  rememberFolder(path: string): void;
}

/** The zones table. `cloneProgress` says how far each clone is: progress lives in memory only. */
export function createZoneTable(
  db: DatabaseSync,
  broadcast: (event: DaemonEvent) => void,
  cloneProgress: (id: string) => Pick<ZoneClone, 'phase' | 'percent'> | undefined,
  /** Where managed clones are (`<reposDir>/<owner>/<repo>`). */
  reposDir: string,
  /** Where groups' own folders are (`groupFolder`). */
  groupsDir: string,
): ZoneTable {
  const selectAll = db.prepare('SELECT * FROM zones ORDER BY rowid');
  const selectOne = db.prepare('SELECT * FROM zones WHERE id = ?');
  const selectCloning = db.prepare('SELECT * FROM zones WHERE clone_repo IS NOT NULL ORDER BY rowid');
  const insert = db.prepare(
    `INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height, tracker_provider, tracker_scope,
       tracker_project, clone_repo, clone_path, clone_made_folder, clone_made_owner)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // A bound zone's repo is its own: binding drops a group's default repo.
  const bind = db.prepare(
    `UPDATE zones SET repo_root = ?, folder = ?, default_repo = NULL, clone_repo = NULL, clone_path = NULL,
       clone_made_folder = NULL, clone_made_owner = NULL WHERE id = ? AND repo_root IS NULL`,
  );
  const bindNotCloning = db.prepare(
    'UPDATE zones SET repo_root = ?, folder = ?, default_repo = NULL WHERE id = ? AND repo_root IS NULL AND clone_repo IS NULL',
  );
  const clearClone = db.prepare(
    'UPDATE zones SET clone_repo = NULL, clone_path = NULL, clone_made_folder = NULL, clone_made_owner = NULL WHERE id = ?',
  );
  const remove = db.prepare('DELETE FROM zones WHERE id = ?');
  const colorUse = db.prepare('SELECT color, count(*) AS n FROM zones GROUP BY color');
  const sessionsIn = db.prepare(
    'SELECT (SELECT count(*) FROM agents WHERE zone_id = ?1) + (SELECT count(*) FROM shells WHERE zone_id = ?1) AS n',
  );
  const remember = db.prepare(
    `INSERT INTO recent_folders (path) VALUES (?)
     ON CONFLICT (path) DO UPDATE SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );

  const toZone = (row: ZoneRow): Zone => ({
    id: row.id,
    kind: row.repo_root === null ? 'unbound' : row.folder === '' ? 'repo' : 'folder',
    repoRoot: row.repo_root,
    folder: row.folder,
    name: row.name,
    color: row.color,
    fillOpacity: row.fill_opacity,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    codexBypassHookTrust: row.codex_bypass_hook_trust === 1,
    boardMcp: row.board_mcp === 1,
    agentsOrchestrate: row.agents_orchestrate === 1,
    gateCommand: row.gate_command,
    tracker:
      row.tracker_provider === null || row.tracker_scope === null
        ? null
        : {
            provider: row.tracker_provider,
            scope: row.tracker_scope,
            ...(row.tracker_project === null ? {} : { project: row.tracker_project }),
          },
    clone:
      row.clone_repo === null || row.clone_path === null
        ? null
        : { repo: row.clone_repo, path: row.clone_path, phase: null, percent: null, ...cloneProgress(row.id) },
    managedClone: row.repo_root !== null && row.folder === '' && isManagedClonePath(reposDir, row.repo_root),
    defaultRepo: row.default_repo,
    groupFolder: row.repo_root === null ? groupFolder(groupsDir, row.id) : null,
    createdAt: row.created_at,
  });
  const find = (id: string) => {
    const row = selectOne.get(id) as ZoneRow | undefined;
    return row === undefined ? undefined : toZone(row);
  };
  const get = (id: string): Zone => find(id) ?? throwNoZone(id);
  const rememberFolder = (path: string) => void remember.run(path);
  const announce = (id: string, extra: { cloneFailed?: string } = {}) => {
    const zone = find(id);
    if (zone !== undefined) broadcast({ type: 'zone.updated', zone, ...extra });
  };

  return {
    get,
    find,
    list: () => (selectAll.all() as unknown as ZoneRow[]).map(toZone),
    insert(zone) {
      const id = zone.id ?? randomUUID();
      insert.run(
        id,
        zone.repoRoot,
        zone.folder,
        zone.name,
        zone.color,
        zone.x,
        zone.y,
        zone.width,
        zone.height,
        zone.tracker?.provider ?? null,
        zone.tracker?.scope ?? null,
        zone.tracker?.project ?? null,
        zone.clone?.repo ?? null,
        zone.clone?.path ?? null,
        zone.clone === undefined ? null : Number(zone.clone.madeFolder),
        zone.clone === undefined ? null : Number(zone.clone.madeOwner),
      );
      if (zone.repoRoot !== null) rememberFolder(folderPath(zone.repoRoot, zone.folder));
      announce(id);
      return get(id);
    },
    bind(id, repoRoot, folder, { clone = false } = {}) {
      if ((clone ? bind : bindNotCloning).run(repoRoot, folder, id).changes === 0) return false;
      rememberFolder(folderPath(repoRoot, folder));
      announce(id);
      return true;
    },
    clearClone: (id) => void clearClone.run(id),
    cloning: () => (selectCloning.all() as unknown as ZoneRow[]).map(toZone),
    cloneFolders(id) {
      const row = selectOne.get(id) as ZoneRow | undefined;
      return { madeFolder: row?.clone_made_folder === 1, madeOwner: row?.clone_made_owner === 1 };
    },
    remove(id, extra = {}) {
      if (remove.run(id).changes === 0) return false;
      broadcast({ type: 'zone.removed', id, ...extra });
      return true;
    },
    holdsSessions: (id) => (sessionsIn.get(id) as { n: number }).n > 0,
    announce,
    leastUsedColor() {
      const uses = new Map((colorUse.all() as { color: string; n: number }[]).map((row) => [row.color, row.n]));
      return ZONE_COLORS.reduce((best, color) => ((uses.get(color) ?? 0) < (uses.get(best) ?? 0) ? color : best));
    },
    rememberFolder,
  };
}

/**
 * The `zone.*` RPC handlers that need no clone, backed by the `zones` table. They don't use the calling connection. A
 * zone is only bound to a tracker scope that `trackers` confirms. `onOrchestrateChanged` hears a zone's
 * `agentsOrchestrate` change, to stop or start the agents it reaches orchestrating.
 */
export function zoneHandlers<Context>(
  db: DatabaseSync,
  zones: ZoneTable,
  trackers: Pick<TrackerHost, 'checkScope'>,
  onOrchestrateChanged: (zoneId: string, on: boolean) => void,
  /** The zone is being removed: the agents being started in it are dismissed, so none runs on with no tile. */
  onRemoving: (zoneId: string) => void = () => {},
): RpcHandlers<ZoneMethods, Context> {
  const updateLayout = db.prepare('UPDATE zones SET x = ?, y = ?, width = ?, height = ? WHERE id = ?');
  const updateName = db.prepare('UPDATE zones SET name = ? WHERE id = ?');
  const updateColor = db.prepare('UPDATE zones SET color = ? WHERE id = ?');
  const updateFillOpacity = db.prepare('UPDATE zones SET fill_opacity = ? WHERE id = ?');
  const updateBypass = db.prepare('UPDATE zones SET codex_bypass_hook_trust = ? WHERE id = ?');
  const updateBoardMcp = db.prepare('UPDATE zones SET board_mcp = ? WHERE id = ?');
  const updateAgentsOrchestrate = db.prepare('UPDATE zones SET agents_orchestrate = ? WHERE id = ?');
  const updateGateCommand = db.prepare('UPDATE zones SET gate_command = ? WHERE id = ?');
  const updateTracker = db.prepare('UPDATE zones SET tracker_provider = ?, tracker_scope = ?, tracker_project = ? WHERE id = ?');
  // Its tracker stays, and so its issue cards and agents' links: a group's issues start agents in a repo picked for
  // each. The tracker is taken away on its own, from the zone's tracker dialog.
  const unbind = db.prepare(`UPDATE zones SET repo_root = NULL, folder = '', default_repo = NULL WHERE id = ?`);
  const updateDefaultRepo = db.prepare('UPDATE zones SET default_repo = ? WHERE id = ?');
  const agentCount = db.prepare('SELECT count(*) AS n FROM agents WHERE zone_id = ?');
  /**
   * Binds of one zone run one at a time, so a second sees the first's result and is refused before it touches the
   * disk. New projects are made one at a time, across zones too, so a second bind to the same folder finds it no
   * longer empty. Neither can then run `git init` over another bind's repo, or undo it.
   */
  const queue = keyedQueue();
  const PROJECTS = 'new projects';
  const changed = (id: string) => {
    zones.announce(id);
    return zones.get(id);
  };

  return {
    'zone.list': () => zones.list(),
    'zone.add': async (params) => {
      const fields = paramsObject(params);
      const path = stringParam(fields, 'path');
      if (!isAbsolute(path)) throw invalidParams(`path must be absolute, got ${path}`);
      const look = newZoneParams(fields, zones);
      const { repoRoot, folder } = await resolveZoneFolder(path);
      const tracker = await checkedTracker(fields, trackers);
      const name = look.name ?? (folder === '' ? basename(repoRoot) : `${basename(repoRoot)}/${folder}`);
      return zones.insert({ ...look, name, repoRoot, folder, tracker });
    },
    'zone.addUnbound': async (params) => {
      const fields = paramsObject(params);
      const name = stringParam(fields, 'name').trim();
      if (name === '') throw invalidParams('name must not be blank');
      const look = newZoneParams(fields, zones);
      const tracker = await checkedTracker(fields, trackers);
      return zones.insert({ ...look, name, repoRoot: null, folder: '', tracker });
    },
    'zone.bind': async (params) => {
      const fields = paramsObject(params);
      const id = stringParam(fields, 'id');
      const as = fields.as;
      const path = stringParam(fields, 'path');
      if (as !== 'repo' && as !== 'project') throw invalidParams(`as must be 'repo' or 'project', got ${String(as)}`);
      if (!isAbsolute(path)) throw invalidParams(`path must be absolute, got ${path}`);
      return queue(`zone ${id}`, async () => {
        const zone = zones.get(id);
        if (zone.repoRoot !== null) throw alreadyBound(zone);
        if (zone.clone !== null) throw stillCloning(zone);
        if (as === 'repo') {
          const { repoRoot, folder } = await resolveZoneFolder(path);
          if (!zones.bind(id, repoRoot, folder)) throw noZone(id);
          return zones.get(id);
        }
        return queue(PROJECTS, async () => {
          const { repoRoot, folder, undo } = await initProject(path);
          // The zone was removed meanwhile: the project made for it is no one's, so it goes.
          if (!zones.bind(id, repoRoot, folder)) {
            await undo();
            throw noZone(id);
          }
          return zones.get(id);
        });
      });
    },
    'zone.unbind': (params) => {
      const id = stringParam(paramsObject(params), 'id');
      return queue(`zone ${id}`, async () => {
        const zone = zones.get(id);
        if (zone.clone !== null) throw stillCloning(zone);
        unbind.run(id);
        return changed(id);
      });
    },
    'zone.setDefaultRepo': async (params) => {
      const fields = paramsObject(params);
      const id = stringParam(fields, 'id');
      const path = fields.path === null ? null : stringParam(fields, 'path');
      if (path !== null && !isAbsolute(path)) throw invalidParams(`path must be absolute, got ${path}`);
      return queue(`zone ${id}`, async () => {
        const zone = zones.get(id);
        if (zone.repoRoot !== null) throw invalidParams(`${zone.name} is bound to a repo already: its agents start there`);
        const folder = path === null ? null : await resolveZoneFolder(path);
        const repo = folder === null ? null : folderPath(folder.repoRoot, folder.folder);
        updateDefaultRepo.run(repo, id);
        if (repo !== null) zones.rememberFolder(repo);
        return changed(id);
      });
    },
    'zone.update': (params) => {
      const fields = paramsObject(params);
      const id = stringParam(fields, 'id');
      const layout = layoutParams(fields);
      if (updateLayout.run(layout.x, layout.y, layout.width, layout.height, id).changes === 0) throw noZone(id);
      return changed(id);
    },
    'zone.configure': (params) => {
      const fields = paramsObject(params);
      const id = stringParam(fields, 'id');
      const bypass = optionalBooleanParam(fields, 'codexBypassHookTrust');
      const boardMcp = optionalBooleanParam(fields, 'boardMcp');
      const agentsOrchestrate = optionalBooleanParam(fields, 'agentsOrchestrate');
      const gateCommand = gateCommandParam(fields);
      if (bypass === undefined && boardMcp === undefined && agentsOrchestrate === undefined && gateCommand === undefined) {
        throw invalidParams('give codexBypassHookTrust, boardMcp, agentsOrchestrate or gateCommand');
      }
      zones.get(id);
      if (gateCommand !== undefined) updateGateCommand.run(gateCommand, id);
      if (bypass !== undefined) updateBypass.run(bypass ? 1 : 0, id);
      if (boardMcp !== undefined) updateBoardMcp.run(boardMcp ? 1 : 0, id);
      if (agentsOrchestrate !== undefined) updateAgentsOrchestrate.run(agentsOrchestrate ? 1 : 0, id);
      // Off, no agent in it orchestrates any more, whoever let it; on, the agents it let orchestrate do again (ADR-0011).
      if (agentsOrchestrate !== undefined) onOrchestrateChanged(id, agentsOrchestrate);
      return changed(id);
    },
    // The colour is any #rrggbb, not only a `ZONE_COLORS` one: the pickers offer those, and zones keep whatever they had.
    'zone.setLook': (params) => {
      const fields = paramsObject(params);
      const id = stringParam(fields, 'id');
      const name = optionalStringParam(fields, 'name')?.trim();
      if (name === '') throw invalidParams('name must not be blank');
      const color = optionalStringParam(fields, 'color')?.toLowerCase();
      if (color !== undefined && !/^#[0-9a-f]{6}$/.test(color)) throw invalidParams(`color must be #rrggbb, got ${color}`);
      const fillOpacity = fields.fillOpacity;
      if (fillOpacity !== undefined && fillOpacity !== null && !validZoneFillOpacity(fillOpacity)) {
        throw invalidParams(`fillOpacity must be a whole percent from 0 to 40 in steps of 2, or null, got ${String(fillOpacity)}`);
      }
      zones.get(id);
      if (name !== undefined) updateName.run(name, id);
      if (color !== undefined) updateColor.run(color, id);
      if (fillOpacity !== undefined) updateFillOpacity.run(fillOpacity, id);
      return changed(id);
    },
    'zone.setTracker': async (params) => {
      const fields = paramsObject(params);
      const id = stringParam(fields, 'id');
      const wanted = zoneTrackerParam(fields);
      zones.get(id); // An unknown zone fails before the tracker is asked anything.
      const tracker = wanted === null ? null : await trackers.checkScope(wanted);
      updateTracker.run(tracker?.provider ?? null, tracker?.scope ?? null, tracker?.project ?? null, id);
      return changed(id);
    },
    'zone.restore': async (params) => {
      const fields = paramsObject(params);
      const id = stringParam(fields, 'id');
      const name = stringParam(fields, 'name').trim();
      if (name === '') throw invalidParams('name must not be blank');
      const color = stringParam(fields, 'color').toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(color)) throw invalidParams(`color must be #rrggbb, got ${color}`);
      const fillOpacity = fields.fillOpacity;
      if (fillOpacity !== null && !validZoneFillOpacity(fillOpacity)) throw invalidParams(`fillOpacity must be a valid percent or null, got ${String(fillOpacity)}`);
      const layout = layoutParams(fields);
      const defaultRepo = fields.defaultRepo === null ? null : stringParam(fields, 'defaultRepo');
      if (defaultRepo !== null && !isAbsolute(defaultRepo)) throw invalidParams(`defaultRepo must be absolute, got ${defaultRepo}`);
      const tracker = zoneTrackerParam(fields);
      const repoRoot = fields.repoRoot === undefined || fields.repoRoot === null ? null : stringParam(fields, 'repoRoot');
      if (repoRoot !== null && !isAbsolute(repoRoot)) throw invalidParams(`repoRoot must be absolute, got ${repoRoot}`);
      const boundFolder = optionalStringParam(fields, 'folder') ?? '';
      return queue(`zone ${id}`, async () => {
        if (zones.find(id) !== undefined) throw invalidParams(`zone ${id} exists already`);
        // As the setter does; but a folder that has gone since is left out, rather than failing the undo it is for.
        const folder = defaultRepo === null ? null : await resolveZoneFolder(defaultRepo).catch(() => null);
        const repo = folder === null ? null : folderPath(folder.repoRoot, folder.folder);
        // A zone that was bound to a repo is bound again if it still is one; if not, it comes back as the group it is.
        const bound = repoRoot === null ? null : await resolveZoneFolder(folderPath(repoRoot, boundFolder)).catch(() => null);
        zones.insert({ ...layout, id, name, color, repoRoot: bound?.repoRoot ?? null, folder: bound?.folder ?? '', tracker });
        updateFillOpacity.run(fillOpacity, id);
        updateBypass.run(optionalBooleanParam(fields, 'codexBypassHookTrust') === false ? 0 : 1, id);
        updateBoardMcp.run(optionalBooleanParam(fields, 'boardMcp') === false ? 0 : 1, id);
        updateAgentsOrchestrate.run(optionalBooleanParam(fields, 'agentsOrchestrate') === false ? 0 : 1, id);
        updateGateCommand.run(gateCommandParam(fields) ?? null, id);
        updateDefaultRepo.run(repo, id);
        if (repo !== null) zones.rememberFolder(repo);
        return changed(id);
      });
    },
    'zone.remove': (params) => {
      const id = stringParam(paramsObject(params), 'id');
      const zone = zones.find(id);
      if (zone?.clone != null) throw invalidParams(`zone ${id} is still cloning; cancel the clone first`);
      if ((agentCount.get(id) as { n: number }).n > 0) throw invalidParams(`zone ${id} still has agents; move them out or delete them first`);
      if (zoneHasShells(db, id)) throw invalidParams(`zone ${id} still has shells; delete them first`);
      if (zone !== undefined) onRemoving(id);
      if (!zones.remove(id)) throw noZone(id);
      return null;
    },
  };
}

/** A new zone's layout and look from wire params: its size and colour defaulted, its name left to the caller. */
export function newZoneParams(
  fields: Record<string, unknown>,
  zones: Pick<ZoneTable, 'leastUsedColor'>,
): ZoneLayout & { name: string | undefined; color: string } {
  const layout = layoutParams({
    x: fields.x,
    y: fields.y,
    width: fields.width ?? DEFAULT_ZONE_SIZE.width,
    height: fields.height ?? DEFAULT_ZONE_SIZE.height,
  });
  const name = optionalStringParam(fields, 'name')?.trim();
  if (name === '') throw invalidParams('name must not be blank');
  const color = fields.color === undefined ? zones.leastUsedColor() : stringParam(fields, 'color').toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) throw invalidParams(`color must be #rrggbb, got ${color}`);
  return { ...layout, name, color };
}

/** The tracker a new zone asks for, checked with the tracker, or null for none. */
async function checkedTracker(
  fields: Record<string, unknown>,
  trackers: Pick<TrackerHost, 'checkScope'>,
): Promise<ZoneTracker | null> {
  if (fields.tracker === undefined || fields.tracker === null) return null;
  const wanted = zoneTrackerParam(fields);
  return wanted === null ? null : trackers.checkScope(wanted);
}

function stillCloning(zone: Zone): RpcMethodError {
  return invalidParams(`${zone.name} is still cloning ${zone.clone?.repo ?? 'its repo'}: wait for it to finish`);
}

/**
 * Finds the git repo a picked folder belongs to. Symlinks are resolved first, so a zone is always recorded against
 * the real repo root, and the folder is its path inside that root ('' when the folder is the root).
 */
export async function resolveZoneFolder(path: string): Promise<{ repoRoot: string; folder: string }> {
  const real = await realpath(path).catch(() => undefined);
  if (real === undefined || !(await stat(real)).isDirectory()) throw invalidParams(`${path} is not a folder`);
  const toplevel = await gitToplevel(real);
  if (toplevel === undefined) throw invalidParams(`${path} is not inside a git repository`);
  const repoRoot = await realpath(toplevel);
  return { repoRoot, folder: relative(repoRoot, real).split(sep).join('/') };
}

/**
 * Makes a new git repo in `path`, an empty folder or a missing one whose parent exists, with an empty first commit so
 * worktrees can branch from it. That commit is unsigned, runs none of the user's hooks and copies no template, so no
 * prompt or failing hook of theirs can stall or break it; it is authored by agent-board when git has no identity to
 * use. On failure it leaves no repo behind, nor a folder it created; `undo` does the same for a caller that can't use
 * the repo after all.
 */
export async function initProject(
  path: string,
): Promise<{ repoRoot: string; folder: string; undo: () => Promise<void> }> {
  const found = await stat(path).catch(() => undefined);
  if (found !== undefined && !found.isDirectory()) throw invalidParams(`${path} is not a folder`);
  // Finder may have left its .DS_Store in a folder that is otherwise empty.
  if (found !== undefined && (await readdir(path)).some((entry) => entry !== '.DS_Store')) {
    throw invalidParams(`${path} is not empty`);
  }
  if (found === undefined) {
    await mkdir(path).catch((error: NodeJS.ErrnoException) => {
      throw invalidParams(`can't create ${path}: ${error.code ?? error.message}`);
    });
  }
  const repoRoot = await realpath(path);
  const git = async (args: string[]) => {
    const { ok, stderr } = await runGit(repoRoot, args);
    if (!ok) throw invalidParams(`can't make a git repo in ${path}: ${stderr}`);
  };
  const undo = () => rm(found === undefined ? repoRoot : join(repoRoot, '.git'), { recursive: true, force: true });
  try {
    // An empty --template keeps init.templateDir's hooks and files out.
    await git(['init', '--quiet', '--template=']);
    const identity = await Promise.all(['user.name', 'user.email'].map((key) => runGit(repoRoot, ['config', key])));
    const fallback = identity.every((result) => result.ok)
      ? []
      : ['-c', 'user.name=agent-board', '-c', 'user.email=agent-board@localhost'];
    // --no-verify skips pre-commit and commit-msg; a hooks path that isn't a folder skips the rest, post-commit too.
    const noHooks = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
    await git([...fallback, ...noHooks, 'commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'Initial commit']);
  } catch (error) {
    await undo();
    throw error;
  }
  return { repoRoot, folder: '', undo };
}

/** The working-tree root containing `dir`, or undefined if `dir` is not in a git work tree. */
async function gitToplevel(dir: string): Promise<string | undefined> {
  const { ok, stdout } = await runGit(dir, ['rev-parse', '--show-toplevel']);
  return ok ? stdout || undefined : undefined;
}

/** A zone's layout from wire params, at least `MIN_ZONE_SIZE`. */
function layoutParams(fields: Record<string, unknown>): ZoneLayout {
  const layout = {
    x: finiteNumberParam(fields, 'x'),
    y: finiteNumberParam(fields, 'y'),
    width: finiteNumberParam(fields, 'width'),
    height: finiteNumberParam(fields, 'height'),
  };
  if (layout.width < MIN_ZONE_SIZE.width || layout.height < MIN_ZONE_SIZE.height) {
    throw invalidParams(`a zone must be at least ${MIN_ZONE_SIZE.width}×${MIN_ZONE_SIZE.height}`);
  }
  return layout;
}

function alreadyBound(zone: Zone): RpcMethodError {
  const path = zone.folder === '' ? zone.repoRoot : `${zone.repoRoot}/${zone.folder}`;
  return invalidParams(`zone ${zone.id} is already bound to ${path}`);
}

function noZone(id: string): RpcMethodError {
  return invalidParams(`no zone ${id}`);
}

function throwNoZone(id: string): never {
  throw noZone(id);
}

/** The `gateCommand` param: undefined when absent, null for none (or only spaces), else a command `gateCommandArgv` can run. */
function gateCommandParam(fields: Record<string, unknown>): string | null | undefined {
  const value = fields.gateCommand;
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw invalidParams('gateCommand must be a string or null');
  const command = value.trim();
  if (command === '') return null;
  try {
    gateCommandArgv(command);
  } catch (error) {
    throw invalidParams((error as Error).message);
  }
  return command;
}
