import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Agent, DaemonEvent, ExternalSession, Shell, TileMove, Zone } from '../src/protocol.ts';
import { zoneDissolveHandlers } from '../src/zone-dissolve.ts';

const zone = { id: 'z', name: 'Strays', kind: 'unbound', repoRoot: null, clone: null, x: 100, y: 200 } as unknown as Zone;
const tile = (id: string, position: { x: number; y: number } | null) => ({ id, sessionId: id, zoneId: 'z', position: position && { ...position, z: null } });

/** Hosts whose moves are rows of one table, so that a rollback can be seen. */
function setup(removeZone: () => Promise<unknown>) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE places (id TEXT PRIMARY KEY, zone TEXT, x REAL, y REAL); INSERT INTO places VALUES ('a', 'z', 10, 20), ('s', 'z', 30, 40), ('e', 'z', NULL, NULL)");
  const events: DaemonEvent[] = [];
  const move = (id: string, to: TileMove) => void db.prepare('UPDATE places SET zone = ?, x = ?, y = ? WHERE id = ?').run(to.zoneId, to.x, to.y, id);
  const handlers = zoneDissolveHandlers<unknown>({
    db,
    zones: { get: () => zone },
    agents: {
      list: () => [tile('a', { x: 10, y: 20 })] as unknown as Agent[],
      get: (id) => tile(id, null) as unknown as Agent,
      move: (id, to) => (move(id, to), tile(id, null) as unknown as Agent),
    },
    shells: {
      list: () => [{ ...tile('s', { x: 30, y: 40 }), id: 's' }] as unknown as Shell[],
      move: (id, to) => (move(id, to), tile(id, null) as unknown as Shell),
    },
    externals: {
      list: () => [{ ...tile('e', null), id: 'e' }] as unknown as ExternalSession[],
      move: (id, to) => (move(id, to), tile(id, null) as unknown as ExternalSession),
      placeUnsorted: () => {},
    },
    broadcast: (event) => events.push(event),
    removeZone,
  });
  const places = () => db.prepare('SELECT id, zone, x, y FROM places ORDER BY id').all();
  return { handlers, places, events };
}

describe('zone.dissolve', () => {
  it('moves every tile loose where it is drawn, by the zone the daemon has, then removes the zone', async () => {
    const removed: string[] = [];
    const { handlers, places } = setup(async () => void removed.push('z'));
    await handlers['zone.dissolve']({ id: 'z' }, undefined);
    // The one with no place goes where the board would slot it first.
    expect(places()).toEqual([
      { id: 'a', zone: null, x: 110, y: 220 },
      { id: 'e', zone: null, x: 120, y: 244 },
      { id: 's', zone: null, x: 130, y: 240 },
    ]);
    expect(removed).toEqual(['z']);
  });

  it('is all or nothing: if the zone cannot be removed no tile has moved, and clients are told where each is', async () => {
    const { handlers, places, events } = setup(() => Promise.reject(new Error('disk full')));
    await expect(handlers['zone.dissolve']({ id: 'z' }, undefined)).rejects.toThrow('disk full');
    expect(places()).toEqual([
      { id: 'a', zone: 'z', x: 10, y: 20 },
      { id: 'e', zone: 'z', x: null, y: null },
      { id: 's', zone: 'z', x: 30, y: 40 },
    ]);
    expect(events.map((event) => event.type).sort()).toEqual(['agent.updated', 'external.updated', 'shell.updated']);
  });
});
