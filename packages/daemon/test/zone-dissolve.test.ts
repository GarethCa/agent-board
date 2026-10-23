import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Agent, DaemonEvent, ExternalSession, Shell, TileMove, Zone } from '../src/protocol.ts';
import { zoneDissolveHandlers } from '../src/zone-dissolve.ts';

const zone = { id: 'z', name: 'Strays', kind: 'unbound', repoRoot: null, clone: null, x: 100, y: 200 } as unknown as Zone;
const tile = (id: string, position: { x: number; y: number } | null) => ({ id, sessionId: id, zoneId: 'z', position: position && { ...position, z: null } });

/** Hosts whose moves are rows of one table, so that a rollback can be seen. */
function setup(removeZone: () => Promise<unknown>, options: { zone?: Zone; agentRepos?: string[]; removeClone?: (path: string) => Promise<void>; worktrees?: string[]; others?: Zone[] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE places (id TEXT PRIMARY KEY, zone TEXT, x REAL, y REAL); INSERT INTO places VALUES ('a', 'z', 10, 20), ('s', 'z', 30, 40), ('e', 'z', NULL, NULL)");
  const events: DaemonEvent[] = [];
  const move = (id: string, to: TileMove) => void db.prepare('UPDATE places SET zone = ?, x = ?, y = ? WHERE id = ?').run(to.zoneId, to.x, to.y, id);
  const handlers = zoneDissolveHandlers<unknown>({
    db,
    zones: { get: () => options.zone ?? zone, list: () => [options.zone ?? zone, ...(options.others ?? [])] },
    agents: {
      list: () => [tile('a', { x: 10, y: 20 }), ...(options.agentRepos ?? []).map((repoRoot, index) => ({ ...tile(`r${index}`, null), zoneId: null, repoRoot }))] as unknown as Agent[],
      get: (id) => tile(id, null) as unknown as Agent,
      move: (id, to) => (move(id, to), tile(id, null) as unknown as Agent),
      starts: () => [],
      updateStart: () => {},
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
    removeClone: options.removeClone ?? (async () => {}),
    linkedWorktrees: async () => options.worktrees ?? [],
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

  const clone = { ...zone, kind: 'repo', repoRoot: '/repos/acme/app', folder: '', managedClone: true } as unknown as Zone;

  it('dissolves a zone bound to a repo like a group, and leaves the repo alone', async () => {
    const removed: string[] = [];
    const cleared: string[] = [];
    const { handlers } = setup(async () => void removed.push('z'), { zone: { ...clone, managedClone: false }, removeClone: async (path) => void cleared.push(path) });
    await handlers['zone.dissolve']({ id: 'z' }, undefined);
    expect(removed).toEqual(['z']);
    expect(cleared).toEqual([]);
  });

  it('keeps a managed clone unless asked, and deletes it once the zone is gone when asked', async () => {
    const order: string[] = [];
    const { handlers } = setup(async () => void order.push('removed'), { zone: clone, removeClone: async (path) => void order.push(`cleared ${path}`) });
    await handlers['zone.dissolve']({ id: 'z' }, undefined);
    expect(order).toEqual(['removed']);
    await handlers['zone.dissolve']({ id: 'z', deleteClone: true }, undefined);
    expect(order).toEqual(['removed', 'removed', 'cleared /repos/acme/app']);
  });

  it('refuses to delete a clone while an agent still has a worktree in it, and changes nothing', async () => {
    const removed: string[] = [];
    const { handlers, places } = setup(async () => void removed.push('z'), { zone: clone, agentRepos: ['/repos/acme/app'] });
    await expect(handlers['zone.dissolve']({ id: 'z', deleteClone: true }, undefined)).rejects.toThrow(/still use/);
    expect(removed).toEqual([]);
    expect(places().every((place) => (place as { zone: string | null }).zone === 'z')).toBe(true);
    // Without deleting the clone it dissolves as ever: the agent keeps its worktree.
    await handlers['zone.dissolve']({ id: 'z' }, undefined);
    expect(removed).toEqual(['z']);
  });

  it('refuses to delete the clone of a zone that is not one', async () => {
    const { handlers } = setup(async () => {}, { zone: { ...clone, managedClone: false } });
    await expect(handlers['zone.dissolve']({ id: 'z', deleteClone: true }, undefined)).rejects.toThrow(/not a clone/);
  });

  it('refuses to delete a clone that still has a worktree linked to it, a kept one too, and changes nothing', async () => {
    const removed: string[] = [];
    const { handlers } = setup(async () => void removed.push('z'), { zone: clone, worktrees: ['/worktrees/kept'] });
    await expect(handlers['zone.dissolve']({ id: 'z', deleteClone: true }, undefined)).rejects.toThrow(/\/worktrees\/kept/);
    expect(removed).toEqual([]);
  });

  it('refuses to delete a clone another zone is bound to, or has as its default repo, or a folder in', async () => {
    const other = (fields: Record<string, unknown>) => ({ id: 'o', name: 'Other', repoRoot: null, defaultRepo: null, ...fields }) as unknown as Zone;
    for (const fields of [{ repoRoot: '/repos/acme/app' }, { repoRoot: '/repos/acme/app' }, { defaultRepo: '/repos/acme/app/apps/web' }]) {
      const { handlers } = setup(async () => {}, { zone: clone, others: [other(fields)] });
      await expect(handlers['zone.dissolve']({ id: 'z', deleteClone: true }, undefined)).rejects.toThrow(/Other is on .*clone too/);
    }
    const { handlers } = setup(async () => {}, { zone: clone, others: [other({ repoRoot: '/repos/acme/app-two' })] });
    await expect(handlers['zone.dissolve']({ id: 'z', deleteClone: true }, undefined)).resolves.toEqual({ cloneError: null });
  });

  it('is done once the zone is gone: a clone that cannot be removed is told, not a failed delete', async () => {
    const removed: string[] = [];
    const { handlers } = setup(async () => void removed.push('z'), { zone: clone, removeClone: () => Promise.reject(new Error('EBUSY')) });
    await expect(handlers['zone.dissolve']({ id: 'z', deleteClone: true }, undefined)).resolves.toEqual({ cloneError: 'EBUSY' });
    expect(removed).toEqual(['z']);
  });
});
