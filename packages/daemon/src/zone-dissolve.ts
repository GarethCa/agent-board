// Dissolving a group: its tiles go loose on the board where they are drawn, and the zone goes, in one step.
import type { DatabaseSync } from 'node:sqlite';
import { invalidParams, paramsObject, stringParam } from './params.ts';
import { TILE_SLOT, type Agent, type DaemonEvent, type DaemonMethods, type ExternalSession, type Shell, type TileMove, type Zone } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';

interface Tile {
  position: { x: number; y: number } | null;
}

export interface ZoneDissolveOptions {
  db: DatabaseSync;
  zones: { get(id: string): Zone };
  agents: { list(): Agent[]; get(sessionId: string): Agent | undefined; move(sessionId: string, move: TileMove): Agent };
  shells: { list(): Shell[]; move(shellId: string, move: TileMove): Shell };
  externals: { list(): ExternalSession[]; move(id: string, move: TileMove): ExternalSession; placeUnsorted(): void };
  broadcast(event: DaemonEvent): void;
  /** Removes the zone, telling clients of the board items that stay (`itemsLeavingZone`). */
  removeZone(id: string): Promise<unknown>;
}

/**
 * The `zone.dissolve` handler. Every move and the removal are one transaction: if any fails, none of them happened and
 * clients are told where every tile is again. A tile that was never given a place goes where the board would slot it.
 */
export function zoneDissolveHandlers<Context>(options: ZoneDissolveOptions): RpcHandlers<Pick<DaemonMethods, 'zone.dissolve'>, Context> {
  const { db, zones, agents, shells, externals } = options;
  return {
    'zone.dissolve': async (params) => {
      const id = stringParam(paramsObject(params), 'id');
      const zone = zones.get(id);
      if (zone.clone !== null) throw invalidParams(`${zone.name} is still cloning: cancel the clone first`);
      if (zone.repoRoot !== null) throw invalidParams(`${zone.name} is bound to a repo: unbind it first`);

      const inZone = {
        agents: agents.list().filter((agent) => agent.zoneId === id),
        shells: shells.list().filter((shell) => shell.zoneId === id),
        externals: externals.list().filter((session) => session.zoneId === id),
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
        await options.removeZone(id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
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
      return null;
    },
  };
}
