import { describe, expect, it } from 'vitest';
import type { Agent, BoardItem, Zone } from '@agent-board/daemon/protocol';
import { itemNode } from './items/items';
import { foldedStack, laidOutTile, pinnedLead, withShelves, type ShelfView, type ShelvesChoice } from './shelves';
import type { TileNodeType } from './tile';
import type { BoardNode } from './tiles';
import { freedFrom, withFreed } from './use-shelves';
import { nudgedTiles } from './use-tile-moves';
import { zoneNode, type ZoneNodeType } from './ZoneNode';

const T0 = '2026-01-05T09:00:00.000Z';

const zone = (id: string, layoutMode: Zone['layoutMode']): Zone =>
  ({ id, kind: 'unbound', name: id, x: 0, y: 0, width: 720, height: 480, spacing: 'normal', layoutMode, repoRoot: null }) as Zone;

function agent(sessionId: string, fields: Partial<Agent> = {}): Agent {
  return {
    sessionId,
    name: sessionId,
    zoneId: 'z',
    branch: `${sessionId}-a1b2c3`,
    reviews: null,
    reviewOf: null,
    role: null,
    roleName: null,
    master: false,
    spawnedBy: null,
    issue: null,
    state: 'running',
    endedAt: null,
    exitCode: null,
    shellSessionId: null,
    shellHarness: null,
    permissions: [],
    ask: null,
    plan: null,
    flag: null,
    ledBy: null,
    seen: false,
    orchestrate: null,
    pullRequests: [],
    finishedAt: null,
    lastMessage: null,
    createdAt: T0,
    ...fields,
  } as Agent;
}

/** A tile node for `id` (`agent:…`, `shell:…`) in zone `z`, saved at `x`, `y`. */
const tile = (id: string, x: number, y: number, parentId = 'z'): TileNodeType => ({ id, type: 'tile', parentId, position: { x, y }, width: 256, height: 136, draggable: true, data: { label: id, harness: null } });

const note = (id: string, about: string): BoardNode =>
  itemNode({ id, kind: 'agent-note', zoneId: 'z', x: 900, y: 40, width: 240, height: 96, rotation: 0, z: null, data: { text: 'hi', agent: { sessionId: 'lead', name: 'lead' }, about } } as unknown as BoardItem) as BoardNode;

const none: ShelvesChoice = { freed: new Set(), doneShown: new Set(), open: null };
const agents = [agent('lead', { orchestrate: 'zone' }), agent('worker', { orchestrate: 'zone', spawnedBy: 'lead' }), agent('other', { zoneId: 'free-zone' })];
const board = (): BoardNode[] => [
  zoneNode(zone('z', 'shelves')),
  zoneNode(zone('free-zone', 'free')),
  tile('agent:lead', 600, 300),
  tile('agent:worker', 40, 40),
  tile('shell:s1', 400, 400),
  tile('agent:other', 40, 40, 'free-zone'),
  note('n1', 'worker'),
];

const byId = (nodes: readonly BoardNode[], id: string) => nodes.find((node) => node.id === id)!;
const shelvesOf = (nodes: readonly BoardNode[]) => (byId(nodes, 'z') as ZoneNodeType).data.shelves as ShelfView;

describe('withShelves', () => {
  it('pins the lead and the shells in the head row and folds every other agent, and its notes, into its card', () => {
    const drawn = withShelves(board(), { agents, links: [], shows: 'explicit', choice: none });
    expect(byId(drawn, 'agent:lead')).toMatchObject({ position: { x: 20, y: 44 }, draggable: false });
    expect(byId(drawn, 'shell:s1')).toMatchObject({ position: { x: 20 + 256 + 16, y: 44 }, draggable: false });
    expect(byId(drawn, 'agent:worker').hidden).toBe(true);
    expect(byId(drawn, 'item:n1').hidden).toBe(true);
    const view = shelvesOf(drawn);
    expect(view.stacks).toMatchObject([{ key: 'agent:worker', stage: 'doing', notes: 1, agents: [{ sessionId: 'worker' }] }]);
    // The zone is drawn as big as its shelves, never smaller than it was saved.
    const node = byId(drawn, 'z');
    expect(node.width).toBe(Math.max(720, view.size.width));
    expect(node.height).toBe(Math.max(480, view.size.height));
  });

  it('leaves a free zone, and every saved place, as they were', () => {
    const before = board();
    const drawn = withShelves(before, { agents, links: [], shows: 'explicit', choice: none });
    expect(byId(drawn, 'agent:other')).toBe(byId(before, 'agent:other'));
    expect(byId(drawn, 'free-zone')).toBe(byId(before, 'free-zone'));
    // What is saved for each tile is its agent's, never the node's drawn place.
    expect(byId(before, 'agent:lead').position).toEqual({ x: 600, y: 300 });
  });

  it('fans the open stack out below the shelves, and puts a freed lead on the shelves', () => {
    const open = withShelves(board(), { agents, links: [], shows: 'explicit', choice: { ...none, open: { zoneId: 'z', key: 'agent:worker' } } });
    const card = shelvesOf(open).stacks[0]!;
    // Below the shelves, from its card's left: over no card.
    expect(byId(open, 'agent:worker')).toMatchObject({ position: { x: card.x, y: shelvesOf(open).fanTop }, draggable: false, zIndex: 6 });
    expect(byId(open, 'agent:worker').hidden).toBeUndefined();
    expect(shelvesOf(open).open).toBe('agent:worker');

    const freed = withShelves(board(), { agents, links: [], shows: 'explicit', choice: { ...none, freed: new Set(['lead']) } });
    expect(byId(freed, 'agent:lead').hidden).toBe(true);
    expect(shelvesOf(freed).stacks.map((stack) => stack.key).sort()).toEqual(['agent:lead', 'agent:worker']);
  });
});

describe('foldedStack', () => {
  it("finds a folded agent's stack, and where its card and fanned tiles go on the board; nothing for a tile drawn as itself", () => {
    const drawn = withShelves(board(), { agents, links: [], shows: 'explicit', choice: none });
    const card = shelvesOf(drawn).stacks[0]!;
    // From its card down to its tiles, fanned out below the shelves.
    const { fanTop } = shelvesOf(drawn);
    expect(foldedStack(drawn, 'worker', 136)).toEqual({ zoneId: 'z', key: 'agent:worker', showDone: false, fan: true, rect: { x: card.x, y: card.y, width: Math.max(card.width, 256), height: fanTop + 136 - card.y } });
    // The lead is in the head row, drawn as itself; one in a free zone too.
    expect(foldedStack(drawn, 'lead', 136)).toBeUndefined();
    // A stack of two is brought into view two tiles wide, as it fans out.
    const pair = [...agents, agent('rev', { reviewOf: 'worker', spawnedBy: 'lead' })];
    const two = withShelves([...board(), tile('agent:rev', 0, 0)], { agents: pair, links: [], shows: 'explicit', choice: none });
    expect(foldedStack(two, 'rev', 136)?.rect.width).toBe(2 * 256 + 16);
    expect(foldedStack(drawn, 'other', 136)).toBeUndefined();
    // Closed, in a folded Done: Done is shown first.
    const closing = [...agents, agent('gone', { endedAt: T0, exitCode: 0, state: 'done', spawnedBy: 'lead' })];
    const done = withShelves([...board(), tile('agent:gone', 0, 0)], { agents: closing, links: [], shows: 'explicit', choice: none });
    expect(foldedStack(done, 'gone', 136)).toMatchObject({ zoneId: 'z', key: 'agent:gone', showDone: true });
  });
});

describe('withShelves in clusters', () => {
  const clustered = (): BoardNode[] => [zoneNode(zone('z', 'clusters')), tile('agent:lead', 600, 300), tile('agent:worker', 40, 40), tile('agent:closed', 300, 300), note('n1', 'worker')];
  const crew = [...agents, agent('closed', { endedAt: T0, exitCode: 0, state: 'done', spawnedBy: 'lead' })];

  it("draws each unit of work's tiles together under the pinned lead, folds Done behind its line, and moves no saved place", () => {
    const before = clustered();
    const drawn = withShelves(before, { agents: crew, links: [], shows: 'explicit', choice: none });
    const view = (byId(drawn, 'z') as ZoneNodeType).data.clusters!;
    const worker = view.clusters.find((cluster) => cluster.key === 'agent:worker')!;
    expect(byId(drawn, 'agent:lead')).toMatchObject({ position: { x: 20, y: 44 }, draggable: false });
    expect(byId(drawn, 'agent:worker')).toMatchObject({ position: { x: worker.tiles[0]!.x, y: worker.tiles[0]!.y }, draggable: false });
    expect(byId(drawn, 'agent:worker').hidden).toBeUndefined();
    expect(worker.notes).toBe(1);
    expect(byId(drawn, 'item:n1').hidden).toBe(true);
    // Closed, it is in Done, folded behind its line until shown.
    expect(byId(drawn, 'agent:closed').hidden).toBe(true);
    expect(view.doneLine).toMatchObject({ count: 1, shown: false });
    expect(foldedStack(drawn, 'closed', 136)).toMatchObject({ zoneId: 'z', key: 'agent:closed', showDone: true, fan: false });
    const shown = withShelves(before, { agents: crew, links: [], shows: 'explicit', choice: { ...none, doneShown: new Set(['z']) } });
    expect(byId(shown, 'agent:closed').hidden).toBeUndefined();
    expect(byId(before, 'agent:worker').position).toEqual({ x: 40, y: 40 });
  });

  it('makes room for an expanded tile, in its cluster or the head row: no tile over another, and the zone holds them all', () => {
    const expanded = (node: TileNodeType): TileNodeType => ({ ...node, width: 900, height: 600, data: { ...node.data, expanded: true } });
    const crew2 = [...crew, agent('other', { spawnedBy: 'lead', createdAt: T0 })];
    for (const which of ['agent:worker', 'agent:lead']) {
      const board: BoardNode[] = [zoneNode(zone('z', 'clusters')), tile('agent:lead', 600, 300), tile('agent:worker', 40, 40), tile('agent:other', 300, 40), tile('agent:closed', 300, 300)].map((node) =>
        node.id === which ? expanded(node as TileNodeType) : node,
      );
      const drawn = withShelves(board, { agents: crew2, links: [], shows: 'explicit', choice: none });
      const zoneDrawn = byId(drawn, 'z');
      const rects = drawn
        .filter((node) => node.type === 'tile' && node.hidden !== true)
        .map((node) => ({ id: node.id, x: node.position.x, y: node.position.y, width: node.width!, height: node.height! }));
      expect(rects.map((rect) => rect.id).sort()).toEqual(['agent:lead', 'agent:other', 'agent:worker']);
      for (const [at, a] of rects.entries()) {
        for (const b of rects.slice(at + 1)) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${a.id} and ${b.id}`).toBe(true);
        expect(a.x + a.width).toBeLessThanOrEqual(zoneDrawn.width!);
        expect(a.y + a.height).toBeLessThanOrEqual(zoneDrawn.height!);
      }
      // Its cluster's outline holds it too.
      const view = (zoneDrawn as ZoneNodeType).data.clusters!;
      for (const cluster of view.clusters.filter((each) => each.placed)) {
        for (const id of cluster.members) {
          const rect = rects.find((each) => each.id === `agent:${id}`)!;
          expect(rect.x + rect.width).toBeLessThanOrEqual(cluster.x + cluster.width);
          expect(rect.y + rect.height).toBeLessThanOrEqual(cluster.y + cluster.height);
        }
      }
    }
  });

  it('brings a jump into a deep, folded Done to where that agent is drawn once Done is shown', () => {
    // Eight closed, one after another: Done runs several rows deep, the first closed last.
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `closed-${n}`);
    const closedCrew = [...agents, ...ids.map((id, n) => agent(id, { endedAt: new Date(Date.parse(T0) + n * 60_000).toISOString(), exitCode: 0, state: 'done', spawnedBy: 'lead' }))];
    const board = (): BoardNode[] => [zoneNode(zone('z', 'clusters')), tile('agent:lead', 600, 300), tile('agent:worker', 40, 40), ...ids.map((id, n) => tile(`agent:${id}`, 40 * n, 400))];
    const folded = withShelves(board(), { agents: closedCrew, links: [], shows: 'explicit', choice: none });
    const jump = foldedStack(folded, 'closed-1', 136)!;
    expect(jump).toMatchObject({ key: 'agent:closed-1', showDone: true, fan: false });
    const shown = withShelves(board(), { agents: closedCrew, links: [], shows: 'explicit', choice: { ...none, doneShown: new Set(['z']) } });
    const zonePlace = byId(shown, 'z').position;
    const tilePlace = byId(shown, 'agent:closed-1').position;
    // Its tile, once drawn, is inside the box flown to.
    expect(zonePlace.x + tilePlace.x).toBeGreaterThanOrEqual(jump.rect.x);
    expect(zonePlace.y + tilePlace.y).toBeGreaterThanOrEqual(jump.rect.y);
    expect(zonePlace.x + tilePlace.x).toBeLessThan(jump.rect.x + jump.rect.width);
    expect(zonePlace.y + tilePlace.y).toBeLessThan(jump.rect.y + jump.rect.height);
    // Below the first rows of Done, where the old guess stopped.
    const view = (byId(shown, 'z') as ZoneNodeType).data.clusters!;
    expect(jump.rect.y - zonePlace.y).toBeGreaterThan(view.doneLine!.y + 2 * 136);
  });
});

describe('laidOutTile', () => {
  it('tells a session tile drawn where its zone lays it out (shelves, clusters) from one at its own place', () => {
    const nodes: BoardNode[] = [
      zoneNode(zone('z', 'shelves')),
      zoneNode(zone('c', 'clusters')),
      zoneNode(zone('free-zone', 'free')),
      tile('agent:a', 0, 0),
      tile('agent:b', 0, 0, 'c'),
      tile('agent:c', 0, 0, 'free-zone'),
      { ...tile('agent:d', 0, 0), parentId: undefined },
      note('n1', 'a'),
    ];
    const by = (id: string) => nodes.find((node) => node.id === id)!;
    expect(laidOutTile(by('agent:a'), nodes)).toBe(true);
    expect(laidOutTile(by('agent:b'), nodes)).toBe(true);
    expect(laidOutTile(by('agent:c'), nodes)).toBe(false);
    expect(laidOutTile(by('agent:d'), nodes)).toBe(false);
    // A user's note in the zone stays where it was put, and moves as ever.
    expect(laidOutTile(nodes.at(-1)!, nodes)).toBe(false);
  });
});

describe('nudgedTiles', () => {
  it('nudges a selected or focused tile at its own place, never one a zone lays out on shelves or in clusters', () => {
    const selected = (node: TileNodeType): TileNodeType => ({ ...node, selected: true });
    const shown: BoardNode[] = [
      zoneNode(zone('z', 'shelves')),
      zoneNode(zone('c', 'clusters')),
      zoneNode(zone('free-zone', 'free')),
      selected(tile('agent:shelved', 0, 0)),
      selected(tile('agent:clustered', 0, 0, 'c')),
      selected(tile('agent:free', 0, 0, 'free-zone')),
      tile('agent:focused', 0, 0, 'free-zone'),
      tile('agent:focused-clustered', 0, 0, 'c'),
      tile('agent:idle', 0, 0, 'free-zone'),
    ];
    expect(nudgedTiles(shown, 'agent:focused').map((node) => node.id)).toEqual(['agent:free', 'agent:focused']);
    expect(nudgedTiles(shown, 'agent:focused-clustered').map((node) => node.id)).toEqual(['agent:free']);
  });
});

describe('pinnedLead', () => {
  it('pins a lead (its crew, its role, the Captain) until the user frees it, never an agent that only may orchestrate', () => {
    const crew = [agent('lead'), agent('worker', { spawnedBy: 'lead' })];
    expect(pinnedLead(crew[0]!, crew, new Set())).toBe(true);
    expect(pinnedLead(crew[0]!, crew, new Set(['lead']))).toBe(false);
    expect(pinnedLead(agent('planner', { roleName: 'orchestrator' }), [], new Set())).toBe(true);
    expect(pinnedLead(agent('captain', { master: true }), [], new Set())).toBe(true);
    expect(pinnedLead(agent('solo', { orchestrate: 'zone' }), crew, new Set())).toBe(false);
    // An implementer that started a helper and its own reviewer is no lead: they are in its stack, not over it.
    const own = [agent('impl', { role: 'implementer' }), agent('helper', { role: 'implementer', spawnedBy: 'impl' })];
    expect(pinnedLead(own[0]!, own, new Set())).toBe(false);
    const reviewed = [agent('solo'), agent('rev', { role: 'reviewer', reviewOf: 'solo', spawnedBy: 'solo' })];
    expect(pinnedLead(reviewed[0]!, reviewed, new Set())).toBe(false);
    // With no role, starting any agent but its own reviewer leads; with a custom role, the helper is in its stack.
    const helped = [agent('fix'), agent('helper', { spawnedBy: 'fix' })];
    expect(pinnedLead(helped[0]!, helped, new Set())).toBe(true);
    const custom = [agent('des', { role: 'custom', roleName: 'designer' }), agent('helper', { spawnedBy: 'des', branch: 'acme-7-login' })];
    expect(pinnedLead(custom[0]!, custom, new Set())).toBe(false);
  });
});

describe('freedFrom', () => {
  it('reads the freed leads stored, once each, and nothing from what is not a list of strings', () => {
    expect(freedFrom('["a","b","a",3]')).toEqual(['a', 'b']);
    expect(freedFrom(undefined)).toEqual([]);
    expect(freedFrom('{')).toEqual([]);
    expect(freedFrom('{"a":1}')).toEqual([]);
  });
});

describe('withFreed', () => {
  it('frees a lead or pins it again, and forgets the agents no longer on the board', () => {
    const live = new Set(['a', 'b']);
    expect(withFreed(['gone', 'a'], 'b', false, live)).toEqual(['a', 'b']);
    expect(withFreed(['a', 'b', 'gone'], 'a', true, live)).toEqual(['b']);
  });
});
