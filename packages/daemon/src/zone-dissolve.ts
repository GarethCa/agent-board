// Deleting a zone: its tiles go loose on the board where they are drawn, and the zone goes, in one step.
import { readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { runGit } from './git.ts';
import { invalidParams, optionalBooleanParam, paramsObject, stringParam } from './params.ts';
import { TILE_SLOT, type Agent, type AgentStart, type DaemonEvent, type DaemonMethods, type ExternalSession, type Shell, type TileMove, type Zone } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';

interface Tile {
  position: { x: number; y: number } | null;
}

export interface ZoneDissolveOptions {
  db: DatabaseSync;
  zones: { get(id: string): Zone; list(): Zone[] };
  agents: {
    list(): Agent[];
    get(sessionId: string): Agent | undefined;
    move(sessionId: string, move: TileMove): Agent;
    /** The agents being started, whose tiles go loose as the agents' do. */
    starts(): AgentStart[];
    updateStart(sessionId: string, change: { move: TileMove }): void;
  };
  shells: { list(): Shell[]; move(shellId: string, move: TileMove): Shell };
  externals: { list(): ExternalSession[]; move(id: string, move: TileMove): ExternalSession; placeUnsorted(): void };
  broadcast(event: DaemonEvent): void;
  /** Removes the zone, telling clients of the board items that stay (`itemsLeavingZone`). */
  removeZone(id: string): Promise<unknown>;
  /** Deletes a managed clone's folder from disk (`removeManagedClone`). */
  removeClone(path: string): Promise<void>;
  /** The paths of the worktrees linked to the repo at `path`, its own checkout left out (`linkedWorktrees`). */
  linkedWorktrees(path: string): Promise<string[]>;
}

/**
 * The worktrees linked to the repo at `path`, other than its own checkout: the ones agents work in, and the ones kept by
 * "Delete, keeping worktrees", whose branches and commits live in this repo's `.git`. It fails closed: nothing is pruned
 * (a worktree whose folder was moved, or is on a volume that isn't mounted, is listed as prunable, and counts), and if
 * git can't say, it throws, so the clone is kept.
 */
export async function linkedWorktrees(path: string): Promise<string[]> {
  const listed = await runGit(path, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) throw invalidParams(`git could not list the worktrees of the clone at ${path}, so it is kept: ${listed.stderr.trim()}`);
  return listed.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .slice(1);
}

const under = (path: string, root: string) => path === root || path.startsWith(root + sep);

/** Deletes the clone at `path`, a managed one (`<reposDir>/<owner>/<repo>`), and its owner's folder if that is empty then. */
export async function removeManagedClone(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
  const owner = dirname(path);
  if ((await readdir(owner).catch(() => ['kept'])).length === 0) await rmdir(owner).catch(() => {});
}

/**
 * The `zone.dissolve` handler, the app's one way to delete a zone, of any kind. Every move and the removal are one
 * transaction: if any fails, none of them happened and clients are told where every tile is again. A tile that was
 * never given a place goes where the board would slot it. Nothing of a session, and not a zone's repo folder, is
 * touched; only with `deleteClone`, a managed clone's folder goes, after the zone has. An agent being started in it
 * carries on, loose where its tile was drawn: its tile is moved before the zone goes (it is in no transaction, so it is
 * put back by hand if the delete fails).
 */
export function zoneDissolveHandlers<Context>(options: ZoneDissolveOptions): RpcHandlers<Pick<DaemonMethods, 'zone.dissolve'>, Context> {
  const { db, zones, agents, shells, externals } = options;
  return {
    'zone.dissolve': async (params) => {
      const fields = paramsObject(params);
      const id = stringParam(fields, 'id');
      const deleteClone = optionalBooleanParam(fields, 'deleteClone') === true;
      const zone = zones.get(id);
      if (zone.clone !== null) throw invalidParams(`${zone.name} is still cloning: cancel the clone first`);
      if (deleteClone) {
        if (!zone.managedClone || zone.repoRoot === null) throw invalidParams(`${zone.name} is not a clone agent-board made, so its folder is left alone`);
        const using = agents.list().filter((agent) => agent.repoRoot === zone.repoRoot);
        if (using.length > 0) {
          throw invalidParams(`${using.length === 1 ? 'An agent still uses' : `${using.length} agents still use`} worktrees in ${zone.name}'s clone: delete ${using.length === 1 ? 'it' : 'them'} first`);
        }
        // Their branches and commits live in the clone: worktrees an agent was deleted from, keeping them, count too.
        const linked = await options.linkedWorktrees(zone.repoRoot);
        if (linked.length > 0) {
          throw invalidParams(`${zone.name}'s clone still has ${linked.length === 1 ? 'a worktree' : `${linked.length} worktrees`} with branches in it (${linked.join(', ')}): remove ${linked.length === 1 ? 'it' : 'them'} first, or keep the clone`);
        }
        const sharing = zones.list().filter((other) => other.id !== id && [other.repoRoot, other.defaultRepo].some((path) => path !== null && under(path, zone.repoRoot!)));
        if (sharing.length > 0) throw invalidParams(`${sharing.map((other) => other.name).join(', ')} ${sharing.length === 1 ? 'is' : 'are'} on ${zone.name}'s clone too: delete ${sharing.length === 1 ? 'it' : 'them'} first, or keep the clone`);
      }

      const inZone = {
        agents: agents.list().filter((agent) => agent.zoneId === id),
        shells: shells.list().filter((shell) => shell.zoneId === id),
        externals: externals.list().filter((session) => session.zoneId === id),
        starts: agents.starts().filter((start) => start.zoneId === id),
      };
      let slot = 0;
      const looseAt = (tile: Tile): TileMove => {
        const at = tile.position ?? {
          x: TILE_SLOT.padding + (slot % 2) * (TILE_SLOT.width + TILE_SLOT.gap),
          y: TILE_SLOT.padding + TILE_SLOT.perchRoom + Math.floor(slot / 2) * (TILE_SLOT.perchRoom + TILE_SLOT.height + TILE_SLOT.gap),
        };
        if (tile.position === null) slot++;
        return { zoneId: null, x: zone.x + at.x, y: zone.y + at.y };
      };

      db.exec('BEGIN IMMEDIATE');
      try {
        for (const agent of inZone.agents) agents.move(agent.sessionId, looseAt(agent));
        for (const shell of inZone.shells) shells.move(shell.id, looseAt(shell));
        for (const session of inZone.externals) externals.move(session.id, looseAt(session));
        for (const start of inZone.starts) agents.updateStart(start.sessionId, { move: looseAt(start) });
        await options.removeZone(id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        // A start still going goes back into the zone; one that became an agent meanwhile is put back with the agents.
        for (const start of inZone.starts) {
          const back = { zoneId: id, ...(start.position ?? { x: 0, y: 0 }) };
          try {
            agents.updateStart(start.sessionId, { move: back });
          } catch {
            // Over already: dismissed, or failed and dismissed.
          }
        }
        // The moves were announced as they were made; say where everything is now.
        for (const agent of inZone.agents) {
          const now = agents.get(agent.sessionId);
          if (now !== undefined) options.broadcast({ type: 'agent.updated', agent: now });
        }
        for (const shell of shells.list().filter((each) => inZone.shells.some((known) => known.id === each.id))) {
          options.broadcast({ type: 'shell.updated', shell });
        }
        for (const session of externals.list().filter((each) => inZone.externals.some((known) => known.id === each.id))) {
          options.broadcast({ type: 'external.updated', session });
        }
        throw error;
      }
      externals.placeUnsorted();
      // The zone is gone for good: a clone that can't be removed is reported, not a failed delete.
      if (deleteClone) {
        const cloneError = await options.removeClone(zone.repoRoot!).then(() => null, (error: unknown) => (error instanceof Error ? error.message : String(error)));
        return { cloneError };
      }
      return { cloneError: null };
    },
  };
}
