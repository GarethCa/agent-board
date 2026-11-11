import { describe, expect, it } from 'vitest';
import { arrangeBoard, BOARD_ARRANGE_GAP, type BoardZone } from '@agent-board/daemon/arrange-board';
import { AGENT_TILE_SIZE, overlaps, sizedFootprint, type Rect } from '@agent-board/daemon/board-layout';
import { FOLDED_ZONE_SIZE, type Agent, type Shell, type Zone } from '@agent-board/daemon/protocol';
import { chipLine, foldedSessionIds, foldedToast, roomToUnfold, unfoldedToast, unfoldMoves, withFoldedExternals, withFoldedZones, type InTheWay } from './fold-zone';
import { zoneNode } from './ZoneNode';
import { tileNodeId, type BoardNode } from './tiles';
import { galleryAgent } from './TileGallery';

const zone = (id: string, folded: boolean): Zone => ({
  id,
  kind: 'unbound',
  repoRoot: null,
  folder: '',
  name: id,
  color: '#4c6ef5',
  fillOpacity: null,
  x: 100,
  y: 50,
  width: 720,
  height: 480,
  codexBypassHookTrust: true,
  trustsFolder: false,
  boardMcp: true,
  agentsOrchestrate: false,
  gateCommand: null,
  spacing: 'normal',
  layoutMode: 'free',
  folded,
  tracker: null,
  clone: null,
  managedClone: false,
  defaultRepo: null,
  groupFolder: null,
  userFolder: false,
  createdAt: '',
});

const agent = (sessionId: string, zoneId: string | null): Agent => ({ ...galleryAgent('idle'), sessionId, zoneId });
const tile = (sessionId: string, parentId: string): BoardNode =>
  ({ id: tileNodeId('agent', sessionId), type: 'tile', parentId, position: { x: 10, y: 10 }, width: 300, height: 200, data: {} }) as unknown as BoardNode;

describe('a folded zone as drawn', () => {
  it('is a chip where it was, and its tiles are hidden; its saved size stays in its data', () => {
    const nodes: BoardNode[] = [zoneNode(zone('z1', true)), zoneNode(zone('z2', false)), tile('a', 'z1'), tile('b', 'z2')];

    const drawn = withFoldedZones(nodes);

    const [folded, open, inFolded, inOpen] = drawn;
    expect(folded).toMatchObject({ id: 'z1', position: { x: 100, y: 50 }, ...FOLDED_ZONE_SIZE });
    expect(folded!.data).toMatchObject({ zone: { width: 720, height: 480 } });
    expect(open).toMatchObject({ id: 'z2', width: 720, height: 480 });
    expect(inFolded!.hidden).toBe(true);
    expect(inOpen!.hidden).not.toBe(true);
  });

  it('is no wider than the zone, so folding a narrow one puts it on no neighbour', () => {
    const narrow = zoneNode({ ...zone('z1', true), width: 240, height: 160 });
    expect(withFoldedZones([narrow])[0]).toMatchObject({ width: 240, height: FOLDED_ZONE_SIZE.height });
  });

  it('leaves the nodes alone when no zone is folded', () => {
    const nodes: BoardNode[] = [zoneNode(zone('z1', false)), tile('a', 'z1')];
    expect(withFoldedZones(nodes)).toEqual(nodes);
  });

  it('is a chip while it is dragged too', () => {
    const dragging = { ...zoneNode(zone('z1', true)), dragging: true } as BoardNode;
    expect(withFoldedZones([dragging])[0]).toMatchObject(FOLDED_ZONE_SIZE);
  });
});

describe('the sessions a folded zone lets go of', () => {
  const shell = (id: string, zoneId: string | null, owner?: string): Shell => ({ id, zoneId, ...(owner === undefined ? {} : { owner: { kind: 'agent', id: owner } }) }) as unknown as Shell;

  it('are its agents, its shells and its agents’ tabs, and nothing from a zone that is not folded', () => {
    const zones = [zone('z1', true), zone('z2', false)];
    const ids = foldedSessionIds(zones, [agent('a', 'z1'), agent('b', 'z2'), agent('c', null)], [shell('s1', 'z1'), shell('s2', 'z2'), shell('tab', null, 'a'), shell('tab2', null, 'b')]);
    expect([...ids].sort()).toEqual(['a', 's1', 'tab']);
  });
});

describe('the room an unfolding zone makes', () => {
  const chip: Rect = { x: 0, y: 0, ...FOLDED_ZONE_SIZE };
  const open: Rect = { x: 0, y: 0, width: 1200, height: 700 };
  const rect = (id: string, x: number, y: number, width = 600, height = 600): InTheWay => ({ id, rect: { x, y, width, height } });
  /** `movables` where `roomToUnfold` leaves them. */
  const after = (movables: readonly InTheWay[], zone = open) => {
    const moves = roomToUnfold(chip, zone, movables);
    return movables.map(({ id, rect }) => ({ id, rect: { ...rect, ...moves.get(id) } }));
  };
  const noneOverlap = (rects: readonly Rect[]) => rects.every((a, index) => rects.slice(index + 1).every((b) => !overlaps(a, b)));

  it('moves nothing when nothing is where the zone opens, however near: a fold then an unfold changes no place', () => {
    // As the zone's neighbours were before it folded, a gap of their own from it: right of it, below it, and a tile.
    const neighbours = [rect('right', 1212, 0), rect('below', 0, 707), rect('corner', 1203, 705), rect('left', -610, 30), rect('above', 0, -640)];
    expect(roomToUnfold(chip, open, neighbours).size).toBe(0);
  });

  it('moves its row along and the rows below down, as whole rows, by what clears it a gap', () => {
    // Arranged round the chip: its row closed up beside it, the next row under that, and a row under that.
    const movables = [rect('b', 340, 0), rect('c', 1020, 0), rect('d', 0, 680), rect('e', 680, 680), rect('f', 1360, 680), rect('g', 0, 1360)];

    const moves = roomToUnfold(chip, open, movables);

    // Its row, right: b is a gap clear of it, c as far from b as it was.
    expect(moves.get('b')).toEqual({ x: 1200 + BOARD_ARRANGE_GAP, y: 0 });
    expect(moves.get('c')).toEqual({ x: 1200 + BOARD_ARRANGE_GAP + 680, y: 0 });
    // The rows below, down: f was never under it, and goes with its row all the same.
    expect(moves.get('d')).toEqual({ x: 0, y: 700 + BOARD_ARRANGE_GAP });
    expect(moves.get('e')).toEqual({ x: 680, y: 780 });
    expect(moves.get('f')).toEqual({ x: 1360, y: 780 });
    expect(moves.get('g')).toEqual({ x: 0, y: 1460 });
    expect(noneOverlap([open, ...after(movables).map((each) => each.rect)])).toBe(true);
  });

  it('puts an arranged board back as it was: arranged, folded, arranged round the chip, then unfolded', () => {
    const others: BoardZone[] = [
      { id: 'b', x: 900, y: 40, width: 640, height: 520 },
      { id: 'c', x: 1700, y: 0, width: 800, height: 900 },
      { id: 'd', x: 0, y: 1000, width: 500, height: 400 },
      { id: 'e', x: 600, y: 1100, width: 700, height: 300 },
      { id: 'f', x: 1500, y: 1000, width: 400, height: 400 },
    ];
    const tiles = [
      { id: 't1', x: 50, y: 1800 },
      { id: 't2', x: 500, y: 1800 },
    ];
    type Board = { zones: BoardZone[]; tiles: typeof tiles };
    const arranged = (board: Board): Board => {
      const moved = arrangeBoard(board.zones, board.tiles);
      return { zones: board.zones.map((each) => ({ ...each, ...moved.zones.get(each.id) })), tiles: board.tiles.map((each) => ({ ...each, ...moved.tiles.get(each.id) })) };
    };
    const movables = (board: Board): InTheWay[] => [
      ...board.zones.filter((zone) => zone.id !== 'a').map(({ id, ...rect }) => ({ id, rect })),
      ...board.tiles.map((tile) => ({ id: tile.id, rect: sizedFootprint(tile, AGENT_TILE_SIZE) })),
    ];
    // Wider than its row, and taller than it.
    for (const size of [{ width: 1200, height: 700 }, { width: 400, height: 1400 }]) {
      const before = arranged({ zones: [{ id: 'a', x: 0, y: 0, ...size }, ...others], tiles });
      const folded = arranged({ ...before, zones: before.zones.map((zone) => (zone.id === 'a' ? { ...zone, ...FOLDED_ZONE_SIZE } : zone)) });
      // The fold let its neighbours close up, or there is nothing to put back.
      expect(movables(folded)).not.toEqual(movables(before));

      expect(after(movables(folded), { x: 0, y: 0, ...size })).toEqual(movables(before));
    }
  });

  it('moves only what is in the way and what goes with it: not the row above, nor what is far off', () => {
    const movables = [
      // In the way, beside the chip; and its neighbour a gap on.
      rect('b', 340, 0),
      rect('c', 1020, 0),
      // The row above b and c, a gap over them: it stays, though it is as near.
      rect('above', 340, -680),
      // Below the chip's row but clear of the zone, and far from anything that moves.
      rect('far', 3000, 900),
    ];

    const moves = roomToUnfold(chip, open, movables);

    expect([...moves.keys()].sort()).toEqual(['b', 'c']);
  });

  it('takes along whatever is in the path of one that moves, so none lands on a neighbour', () => {
    // Dropped in the room the fold freed, with a zone further down that was never in the way.
    const movables = [rect('dropped', 100, 300, 300, 200), rect('further', 100, 1000)];

    const moves = roomToUnfold(chip, open, movables);

    expect(moves.get('dropped')).toEqual({ x: 100, y: 780 });
    // The same shift, so it is as far below as it was.
    expect(moves.get('further')).toEqual({ x: 100, y: 1480 });
    expect(noneOverlap([open, ...after(movables).map((each) => each.rect)])).toBe(true);
  });

  it('leaves what lies over the chip itself, as it was put there', () => {
    expect(roomToUnfold(chip, open, [rect('over', 100, -20, 300, 200)]).size).toBe(0);
  });

  it('moves the zones and the loose agents in the way, by node id, and leaves what is in a zone, another session’s tile and a zone not folded', () => {
    const folded = zoneNode({ ...zone('z1', true), x: 0, y: 0, width: 1200, height: 700 });
    const beside = zoneNode({ ...zone('z2', false), x: 340, y: 0 });
    const chipBelow = zoneNode({ ...zone('z3', true), x: 0, y: 128 });
    const loose = (id: string, x: number, y: number): BoardNode => ({ id, type: 'tile', position: { x, y }, data: {} }) as unknown as BoardNode;
    const nodes = [folded, beside, chipBelow, tile('inside', 'z2'), loose(tileNodeId('agent', 'mine'), 100, 900), loose(tileNodeId('external', 'theirs'), 800, 300)];

    const moves = unfoldMoves(nodes, 'z1', () => AGENT_TILE_SIZE);

    expect(moves.get('z2')).toEqual({ x: 1200 + BOARD_ARRANGE_GAP, y: 0 });
    // The other folded zone is its chip: below this one, and moved down as the chip it is drawn as.
    expect(moves.get('z3')).toEqual({ x: 0, y: 700 + BOARD_ARRANGE_GAP });
    // The loose agent was under the chip that moved down, in its path: it keeps its place below it.
    expect(moves.get(tileNodeId('agent', 'mine'))).toEqual({ x: 100, y: 900 + 652 });
    expect([...moves.keys()].sort()).toEqual([tileNodeId('agent', 'mine'), 'z2', 'z3'].sort());
    expect(unfoldMoves(nodes, 'z2', () => AGENT_TILE_SIZE).size).toBe(0);
  });
});

describe('what a folded zone’s chip says', () => {
  // z2 is not folded.
  const zones = ['z1', 'z3'];
  const external = (zoneId: string | null, state: 'running' | 'needs-permission', endedAt: string | null = null) => ({ zoneId, state, endedAt });

  it('counts the external sessions its chip hides: one asking for a permission needs you, the rest are external', () => {
    const summaries = new Map([['z1', { needsYou: 1, line: '2 paused' }]]);
    const chips = withFoldedExternals(summaries, zones, [external('z1', 'needs-permission'), external('z1', 'running'), external('z1', 'running')]);
    expect(chips.get('z1')).toEqual({ needsYou: 2, line: '2 paused · 2 external' });
  });

  it('counts them in a folded zone with no agents, and one that ended as external only', () => {
    const chips = withFoldedExternals(new Map(), zones, [external('z3', 'needs-permission'), external('z3', 'needs-permission', '2026-11-10T10:00:00Z')]);
    expect(chips.get('z3')).toEqual({ needsYou: 1, line: '1 external' });
    expect(withFoldedExternals(new Map(), zones, [external('z3', 'needs-permission')]).get('z3')).toEqual({ needsYou: 1, line: '' });
  });

  it('leaves a zone that is not folded, and one with no external session, as it was, and counts none loose on the board', () => {
    const summaries = new Map([
      ['z1', { needsYou: 0, line: '1 paused' }],
      ['z2', { needsYou: 0, line: '1 working' }],
    ]);
    const chips = withFoldedExternals(summaries, zones, [external('z2', 'needs-permission'), external(null, 'needs-permission')]);
    expect([...chips]).toEqual([...summaries]);
  });

  it('reads the rest after the count of those that need you, the rest alone, or that it has no agents', () => {
    expect(chipLine(undefined)).toBe('No agents');
    expect(chipLine({ needsYou: 0, line: '' })).toBe('No agents');
    expect(chipLine({ needsYou: 0, line: '1 paused' })).toBe('1 paused');
    expect(chipLine({ needsYou: 1, line: '2 paused · 1 external' })).toBe('· 2 paused · 1 external');
    // Its count says it all.
    expect(chipLine({ needsYou: 2, line: '' })).toBe('');
  });
});

describe('what the board says once a zone is folded', () => {
  const zone = { name: 'web' } as Zone;

  it('says it is folded, and how many agents were paused', () => {
    expect(foldedToast({ zone, paused: [], kept: [] })).toEqual({ tone: 'success', message: 'web is folded.' });
    expect(foldedToast({ zone, paused: ['a'], kept: [] })).toEqual({ tone: 'success', message: 'web is folded. 1 agent paused.' });
    expect(foldedToast({ zone, paused: ['a', 'b'], kept: [] }).message).toBe('web is folded. 2 agents paused.');
  });

  it('names each agent left running with why, without what to do about it, and is no success then', () => {
    // The daemon's reasons, word for word (`pauseRefusal`, `agents.pause`).
    const kept = [
      { sessionId: 'b', name: 'Alpha', why: 'it is mid-turn: finish its turn first' },
      { sessionId: 'c', name: 'Beta', why: 'a message is being sent to it: wait for its turn' },
      { sessionId: 'd', name: 'Gamma', why: 'it is waiting on you' },
    ];
    expect(foldedToast({ zone, paused: ['a'], kept })).toEqual({
      tone: 'info',
      message: 'web is folded. 1 agent paused. Left running: Alpha, as it is mid-turn; Beta, as a message is being sent to it; Gamma, as it is waiting on you.',
    });
  });
});

describe('what the board says once a zone is unfolded', () => {
  const zone = { name: 'web' } as Zone;

  it('says only that it is unfolded when none of its agents is paused', () => {
    expect(unfoldedToast({ zone, woken: [], asleep: [] }, 0)).toEqual({ tone: 'success', message: 'web is unfolded.' });
  });

  it('counts the agents that stay paused when none was asked to wake', () => {
    expect(unfoldedToast({ zone, woken: [], asleep: [] }, 1).message).toBe('web is unfolded. 1 agent stays paused until you wake it.');
    expect(unfoldedToast({ zone, woken: [], asleep: [] }, 3).message).toBe('web is unfolded. 3 agents stay paused until you wake them.');
  });

  it('counts those waking, and names each that would not wake with why, once, as no success', () => {
    const asleep = [
      { sessionId: 'c', name: 'ada', why: 'its worktree is gone' },
      { sessionId: 'd', name: 'bob', why: 'claude is running in its shell: exit it first' },
    ];
    expect(unfoldedToast({ zone, woken: ['a', 'b'], asleep }, 3)).toEqual({
      tone: 'info',
      message: 'web is unfolded. 2 agents waking. Still paused: ada, as its worktree is gone; bob, as claude is running in its shell. 1 agent stays paused until you wake it.',
    });
  });
});
