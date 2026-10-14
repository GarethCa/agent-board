// External sessions: harness sessions agent-board did not spawn, reported by the opt-in global hooks
// (`external-hooks.ts`) and drawn on the board in the zone matching their folder, or in the Unsorted group.
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { stateAfterHook } from './harness-state.ts';
import { keyedQueue } from './keyed-queue.ts';
import { runGit } from './git.ts';
import { invalidParams, paramsObject, stringParam } from './params.ts';
import { MAX_DESCRIPTION_LENGTH, TILE_SLOT, UNSORTED_GROUP_WIDTH, unsortedGroupHeight } from './protocol.ts';
import { createZoneTable } from './zones.ts';
import type {
  SessionState,
  DaemonEvent,
  DaemonMethods,
  ExternalSession,
  Harness,
  StatusFile,
  TileMove,
} from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import { createSubagentStore, subagentsAfterExit, subagentsAfterHook } from './subagents.ts';
import { moveParams, saveMove, tilePosition, type PositionColumns } from './tile-position.ts';

/** Space between the Unsorted group and the zone it is put right of, and its neutral grey. */
const UNSORTED_GAP = 40;
const UNSORTED_COLOR = '#868e96';

/** How long an ended external session stays on the board, at most, across daemon restarts. */
const KEEP_ENDED_MS = 24 * 60 * 60 * 1000;

/** How long a session that never reported its end is kept with no hook from it: it most likely died. */
const KEEP_SILENT_MS = 7 * 24 * 60 * 60 * 1000;

/** Where a session runs, as far as zones care. */
export interface SessionPlace {
  /** The git working tree its folder is in, or null outside git. */
  worktree: string | null;
  /** That tree's main repo: itself, unless it is a linked worktree. */
  repoRoot: string | null;
  /** Its folder inside `worktree`, `/`-separated; '' at the root or outside git. */
  folder: string;
  branch: string | null;
}

const NOWHERE: SessionPlace = { worktree: null, repoRoot: null, folder: '', branch: null };

/** Finds the working tree, main repo, folder and branch of `cwd`, symlinks resolved as zones' paths are. */
export async function sessionPlace(cwd: string): Promise<SessionPlace> {
  const real = await realpath(cwd).catch(() => undefined);
  if (real === undefined) return NOWHERE;
  const top = await runGit(real, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']).catch(
    () => undefined,
  );
  if (!top?.ok) return NOWHERE;
  const [toplevel, commonDir] = top.stdout.split('\n');
  if (!toplevel || !commonDir) return NOWHERE;
  const worktree = await realpath(toplevel);
  // A linked worktree's common dir is its main repo's `.git`; a bare repo's is the repo itself.
  const repoRoot = basename(commonDir) === '.git' ? await realpath(dirname(commonDir)).catch(() => worktree) : worktree;
  const branch = await runGit(real, ['branch', '--show-current']).catch(() => undefined);
  return {
    worktree,
    repoRoot,
    folder: relative(worktree, real).split(sep).join('/'),
    branch: branch?.ok && branch.stdout !== '' ? branch.stdout : null,
  };
}

/** A zone, as placement needs it. */
export interface PlacementZone {
  id: string;
  /** Null for an unbound zone. */
  repo_root: string | null;
  folder: string;
}

/**
 * The zone a session at `place` is drawn in: a zone of its repo (or of the worktree itself) whose folder holds its
 * folder, the most specific first, and the oldest of equals. Unbound zones hold none. Null means the Unsorted group.
 */
export function zoneForPlace(zones: readonly PlacementZone[], place: SessionPlace): string | null {
  let best: PlacementZone | undefined;
  for (const zone of zones) {
    if (zone.repo_root === null || (zone.repo_root !== place.repoRoot && zone.repo_root !== place.worktree)) continue;
    const holds = zone.folder === '' || place.folder === zone.folder || place.folder.startsWith(`${zone.folder}/`);
    if (holds && (best === undefined || zone.folder.length > best.folder.length)) best = zone;
  }
  return best?.id ?? null;
}

/**
 * `status` if it is `row`'s own: a file that names no session belongs to whichever session is in its worktree, one
 * that does belongs only to that session.
 */
function statusOf(row: { session_id: string; harness: Harness }, status: StatusFile | null): StatusFile | null {
  if (status === null || status.sessionId === null) return status;
  return status.sessionId === row.session_id && (status.harness === null || status.harness === row.harness) ? status : null;
}

/** The status file a worker's hooks write in its worktree. */
function statusFilePath(worktree: string): string {
  return join(worktree, '.agent-board', 'status.json');
}

/** The worker status in `worktree`, or null if there is no readable status file with a state. */
export function readStatusFile(worktree: string): StatusFile | null {
  let file: Record<string, unknown>;
  try {
    file = JSON.parse(readFileSync(statusFilePath(worktree), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof file !== 'object' || file === null || typeof file.state !== 'string') return null;
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  return {
    state: file.state,
    summary: text(file.summary) ?? '',
    issue: text(file.issue),
    role: text(file.role),
    handover: text(file.handover),
    reviewDoc: text(file.review_doc),
    updatedAt: text(file.updated_at),
    sessionId: text(file.session_id),
    harness: text(file.harness),
  };
}

interface ExternalRow extends PositionColumns {
  position_zone_id: string | null;
  id: string;
  harness: Harness;
  session_id: string;
  cwd: string;
  worktree: string | null;
  repo_root: string | null;
  folder: string;
  branch: string | null;
  description: string;
  state: SessionState;
  transcript_path: string | null;
  created_at: string;
  last_event_at: string;
  ended_at: string | null;
  dismissed_at: string | null;
}

/** An external session as resuming it in agent-board needs it. */
export interface ResumableSession extends ExternalSession {
  /** The main repo of its worktree when first seen, or null outside git. */
  repoRoot: string | null;
  /** Its folder inside its worktree, `/`-separated; '' at the root or outside git. */
  folder: string;
  /** Its transcript, if a hook has named it. */
  transcriptPath: string | null;
}

export interface ExternalSessionHostOptions {
  db: DatabaseSync;
  /**
   * Whether a session id is one of agent-board's own agents, which its own hooks report: one it spawned, or an external
   * session it adopted, which may still be running in its old terminal too.
   */
  isAgentSession(sessionId: string): boolean;
  broadcast(event: DaemonEvent): void;
  log(message: string): void;
  /** How often a live session's status file is checked for changes. */
  statusPollMs?: number;
}

export interface ExternalSessionHost {
  /** Records a global hook's call: a new session appears, a known one moves. */
  onHook(harness: Harness, payload: Record<string, unknown>): Promise<void>;
  list(): ExternalSession[];
  /**
   * Takes a session off the board. A live one stays off, its hooks followed out of sight, until it starts again
   * (`SessionStart`, e.g. a resume); an ended one is forgotten.
   */
  dismiss(id: string): void;
  /**
   * Makes the Unsorted group if sessions shown have no zone and no place and no unbound marked group exists (see
   * `placeUnsorted` below). Called when a zone change may have left sessions with none: the host does the rest itself.
   */
  placeUnsorted(): void;
  /** Moves the session's tile within its zone, into any other, or out onto the board. Only its tile moves. */
  move(id: string, move: TileMove): ExternalSession;
  /** The session, shown on the board, as resuming it needs it; undefined for an unknown or dismissed one. */
  resumable(id: string): ResumableSession | undefined;
  /** Forgets a session adopted as an agent: its tile is the agent's now, and its hooks are the agent's. */
  adopted(id: string): void;
  /** Stops watching status files. */
  stop(): void;
}

/**
 * Owns external sessions, in the `external_sessions` table so they outlive the daemon (which exits when the app has
 * been closed a while, while the sessions run on). A session's tile follows its hooks as an agent's does (ADR-0004),
 * and shows its worktree's status file, watched while the session is live. Ended sessions are dropped a day after
 * they end, and silent ones after a week, when a daemon starts.
 */
export function createExternalSessionHost(options: ExternalSessionHostOptions): ExternalSessionHost {
  const { db } = options;
  const statusPollMs = options.statusPollMs ?? 1_000;
  const selectShown = db.prepare('SELECT * FROM external_sessions WHERE dismissed_at IS NULL ORDER BY created_at, rowid');
  const selectOne = db.prepare('SELECT * FROM external_sessions WHERE id = ?');
  const selectZones = db.prepare('SELECT id, repo_root, folder FROM zones ORDER BY rowid');
  const selectUnsorted = db.prepare('SELECT id FROM zones WHERE unsorted = 1 AND repo_root IS NULL ORDER BY rowid LIMIT 1');
  // The right edge of each zone as the board draws it: grown to hold the tiles saved in it, as `fitToTiles` does.
  const selectExtents = db.prepare(
    `SELECT z.x, z.y, z.width,
       (SELECT max(x) FROM (
          SELECT x FROM agents WHERE zone_id = z.id AND x IS NOT NULL
          UNION ALL SELECT x FROM shells WHERE zone_id = z.id AND x IS NOT NULL
          UNION ALL SELECT x FROM external_sessions WHERE position_zone_id = z.id AND x IS NOT NULL)) AS tile_x
     FROM zones z`,
  );
  const markUnsorted = db.prepare('UPDATE zones SET unsorted = 1 WHERE id = ?');
  const zoneTable = createZoneTable(db, options.broadcast, () => undefined);
  const insert = db.prepare(
    `INSERT INTO external_sessions (id, harness, session_id, cwd, worktree, repo_root, folder, branch, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle')`,
  );
  const update = db.prepare(
    `UPDATE external_sessions SET state = ?, description = ?, transcript_path = ?, ended_at = ?, dismissed_at = ?,
     last_event_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  );
  const remove = db.prepare('DELETE FROM external_sessions WHERE id = ?');
  const updatePlace = db.prepare('UPDATE external_sessions SET position_zone_id = ?, x = ?, y = ?, z = ? WHERE id = ?');
  const markDismissed = db.prepare(
    "UPDATE external_sessions SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND dismissed_at IS NULL",
  );

  const now = Date.now();
  const pruned = db
    .prepare('DELETE FROM external_sessions WHERE ended_at < ? OR (ended_at IS NULL AND last_event_at < ?)')
    .run(new Date(now - KEEP_ENDED_MS).toISOString(), new Date(now - KEEP_SILENT_MS).toISOString());
  if (pruned.changes > 0) options.log(`dropped ${pruned.changes} old external session(s)`);

  const subagents = createSubagentStore();

  const unsortedId = () => (selectUnsorted.get() as { id: string } | undefined)?.id ?? null;

  const toSession = (
    row: ExternalRow,
    zones = selectZones.all() as unknown as PlacementZone[],
    unsorted: string | null = unsortedId(),
  ): ExternalSession => {
    const status = row.worktree === null ? null : statusOf(row, readStatusFile(row.worktree));
    const workerName = [status?.issue, status?.role].filter(Boolean).join(' ');
    // Where it was put, while that zone is still there; else where its folder puts it, to be slotted in.
    const position = tilePosition(row);
    const placed = isPlaced(row, zones);
    // With neither, the Unsorted group holds it, if there is one: see `placeUnsorted`.
    const zoneId = placed
      ? row.position_zone_id
      : (zoneForPlace(zones, { worktree: row.worktree, repoRoot: row.repo_root, folder: row.folder, branch: row.branch }) ??
        unsorted);
    return {
      id: row.id,
      harness: row.harness,
      sessionId: row.session_id,
      zoneId,
      position: placed ? position : null,
      name: workerName || basename(row.worktree ?? row.cwd) || row.cwd,
      cwd: row.cwd,
      worktree: row.worktree,
      branch: row.branch,
      description: row.description,
      state: row.state,
      status,
      createdAt: row.created_at,
      lastEventAt: row.last_event_at,
      endedAt: row.ended_at,
      subagents: [...subagents.of(row.id)],
    };
  };

  /**
   * Makes sure the sessions shown that no zone holds, and that were never put anywhere, have a group to be in: the
   * Unsorted group, made right of every zone and level with the topmost the first time one has none, and kept (the
   * user may move, resize, rename and dissolve it like any group) until it is bound or removed, when the next such
   * session gets a fresh one. Its zone is announced before any session says it is in it.
   */
  const placeUnsorted = () => {
    if (selectUnsorted.get() !== undefined) return;
    const zones = selectZones.all() as unknown as PlacementZone[];
    const unplaced = (selectShown.all() as unknown as ExternalRow[]).filter(
      (row) =>
        !isPlaced(row, zones) &&
        zoneForPlace(zones, { worktree: row.worktree, repoRoot: row.repo_root, folder: row.folder, branch: row.branch }) === null,
    );
    if (unplaced.length === 0) return;
    const extents = selectExtents.all() as unknown as { x: number; y: number; width: number; tile_x: number | null }[];
    const drawnRight = (extent: (typeof extents)[number]) =>
      extent.x + Math.max(extent.width, extent.tile_x === null ? 0 : extent.tile_x + TILE_SLOT.width + TILE_SLOT.padding);
    const right = extents.length === 0 ? null : Math.max(...extents.map(drawnRight));
    const top = extents.length === 0 ? null : Math.min(...extents.map((extent) => extent.y));
    const zone = zoneTable.insert({
      repoRoot: null,
      folder: '',
      name: 'Unsorted',
      color: UNSORTED_COLOR,
      x: right === null ? 0 : right + UNSORTED_GAP,
      y: top ?? 0,
      width: UNSORTED_GROUP_WIDTH,
      height: unsortedGroupHeight(unplaced.length),
      tracker: null,
    });
    markUnsorted.run(zone.id);
    options.log(`made the Unsorted group for ${unplaced.length} external session(s)`);
  };

  const get = (id: string): ExternalSession | undefined => {
    const row = selectOne.get(id) as ExternalRow | undefined;
    return row && toSession(row);
  };

  const broadcast = (id: string) => {
    const session = get(id);
    if (session !== undefined) options.broadcast({ type: 'external.updated', session });
  };

  /**
   * Status files of live sessions, watched by reading them on an interval: it works on files that don't exist yet.
   * Their content is compared, not their stat (`fs.watchFile`), whose first stat is taken later than the first read
   * and so can miss a change made in between.
   */
  const watched = new Map<string, () => void>();
  const watchStatus = (id: string, worktree: string | null) => {
    if (worktree === null || watched.has(id)) return;
    let last = JSON.stringify(readStatusFile(worktree));
    const timer = setInterval(() => {
      const next = JSON.stringify(readStatusFile(worktree));
      if (next === last) return;
      last = next;
      broadcast(id);
    }, statusPollMs);
    timer.unref();
    watched.set(id, () => clearInterval(timer));
  };
  const unwatchStatus = (id: string) => {
    watched.get(id)?.();
    watched.delete(id);
  };

  for (const row of selectShown.all() as unknown as ExternalRow[]) if (row.ended_at === null) watchStatus(row.id, row.worktree);
  // A board from before Unsorted was a group has sessions in no zone: they go in it, where the old area was.
  placeUnsorted();

  /** A session's hooks are handled one at a time, in order: its first one waits on git to place it. */
  const inSessionQueue = keyedQueue();

  return {
    onHook(harness, payload) {
      const sessionId = payload.session_id;
      if (typeof sessionId !== 'string' || sessionId === '') return Promise.resolve();
      if (options.isAgentSession(sessionId)) return Promise.resolve();
      const id = `${harness}:${sessionId}`;
      const event = payload.hook_event_name;
      return inSessionQueue(id, async () => {
        let row = selectOne.get(id) as ExternalRow | undefined;
        let revived = false;
        let appeared = false;
        // Out of sight until it starts again; ending while dismissed forgets it.
        if (row?.dismissed_at != null && event === 'SessionEnd') {
          remove.run(id);
          subagents.delete(id);
          return;
        }
        if (row?.dismissed_at != null && event === 'SessionStart') {
          row = { ...row, dismissed_at: null };
          revived = true;
        }
        const hidden = row?.dismissed_at != null;
        if (row === undefined) {
          // A session first heard of as it ends would only leave a tile behind.
          if (event === 'SessionEnd') return;
          const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
          const place = cwd === '' ? NOWHERE : await sessionPlace(cwd);
          insert.run(id, harness, sessionId, cwd, place.worktree, place.repoRoot, place.folder, place.branch);
          row = selectOne.get(id) as unknown as ExternalRow;
          appeared = true;
          options.log(`external ${harness} session ${sessionId} in ${cwd}`);
        } else if (row.ended_at !== null) {
          // Only a resume brings an ended session back; anything else is a straggler from before its end.
          if (event !== 'SessionStart') return;
          row = { ...row, ended_at: null };
          revived = true;
        }

        const ended = event === 'SessionEnd';
        const state = stateAfterHook(harness, row.state, payload);
        const nowDate = new Date();
        const nextSubagents = ended
          ? subagentsAfterExit(subagents.of(id), state, nowDate)
          : subagentsAfterHook(subagents.of(id), payload, nowDate);
        const prompt = event === 'UserPromptSubmit' && typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
        const description = row.description || prompt.slice(0, MAX_DESCRIPTION_LENGTH);
        const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : row.transcript_path;
        const endedAt = ended ? nowDate.toISOString() : row.ended_at;

        const changed =
          revived ||
          state !== row.state ||
          description !== row.description ||
          endedAt !== row.ended_at ||
          nextSubagents !== subagents.of(id);
        update.run(state, description, transcript, endedAt, row.dismissed_at, id);
        // Only a session that has just appeared (or is back) may be one no zone holds.
        if (!hidden && (appeared || revived)) placeUnsorted();
        subagents.set(id, nextSubagents);
        if (ended || hidden) unwatchStatus(id);
        else watchStatus(id, row.worktree);
        if (changed && !hidden) broadcast(id);
      });
    },

    list() {
      const zones = selectZones.all() as unknown as PlacementZone[];
      const unsorted = unsortedId();
      return (selectShown.all() as unknown as ExternalRow[]).map((row) => toSession(row, zones, unsorted));
    },

    placeUnsorted,

    dismiss(id) {
      const row = selectOne.get(id) as ExternalRow | undefined;
      if (row === undefined || row.dismissed_at !== null) throw invalidParams(`no external session ${id}`);
      if (row.ended_at === null) markDismissed.run(id);
      else remove.run(id);
      unwatchStatus(id);
      subagents.delete(id);
      options.broadcast({ type: 'external.removed', id });
    },

    move(id, move) {
      const session = get(id);
      if (session === undefined) throw invalidParams(`no external session ${id}`);
      if (move.zoneId !== null && !hasZone(selectZones.all() as unknown as PlacementZone[], move.zoneId)) {
        throw invalidParams(`no zone ${move.zoneId}`);
      }
      saveMove(db, updatePlace, id, session.position, move);
      broadcast(id);
      return get(id)!;
    },

    resumable(id) {
      const row = selectOne.get(id) as ExternalRow | undefined;
      if (row === undefined || row.dismissed_at !== null) return undefined;
      return { ...toSession(row), repoRoot: row.repo_root, folder: row.folder, transcriptPath: row.transcript_path };
    },

    adopted(id) {
      remove.run(id);
      unwatchStatus(id);
      subagents.delete(id);
      options.broadcast({ type: 'external.removed', id });
    },

    stop() {
      for (const id of [...watched.keys()]) unwatchStatus(id);
    },
  };
}

/** Whether the session was put somewhere that still holds: loose, or in a zone that is still there. */
function isPlaced(row: ExternalRow, zones: readonly PlacementZone[]): boolean {
  return tilePosition(row) !== null && (row.position_zone_id === null || hasZone(zones, row.position_zone_id));
}

/** Whether `zones` has the zone `id`. */
function hasZone(zones: readonly PlacementZone[], id: string): boolean {
  return zones.some((zone) => zone.id === id);
}

/** The `external.*` RPC handlers. */
export function externalHandlers<Context>(
  external: ExternalSessionHost,
): RpcHandlers<Pick<DaemonMethods, 'external.list' | 'external.move' | 'external.dismiss'>, Context> {
  return {
    'external.list': () => external.list(),
    'external.move': (params) => {
      const p = paramsObject(params);
      return external.move(stringParam(p, 'id'), moveParams(p));
    },
    'external.dismiss': (params) => {
      external.dismiss(stringParam(paramsObject(params), 'id'));
      return null;
    },
  };
}
