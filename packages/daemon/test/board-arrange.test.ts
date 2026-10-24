import { describe, expect, it } from 'vitest';
import { arrangeTiles, CLUSTER_LABEL_SIZE, CLUSTER_NOTE_SIZE, parkClusters, ticketOfBranch, type ArrangeTile } from '../src/board-arrange.ts';
import { AGENT_TILE_SIZE, clearOf, PERCH_ROOM, RAIL_GAP, ROW_STEP, sizedFootprint, SPACING_GAPS, TILE_GAP, ZONE_PADDING, type Point, type Rect } from '../src/board-layout.ts';
import { ARRANGE_SPACINGS } from '../src/protocol.ts';

const COLUMN = AGENT_TILE_SIZE.width + TILE_GAP;
/** Where a zone's first grid row starts. */
const GRID_ROW_TOP = ZONE_PADDING + PERCH_ROOM;
const FIRST = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };

function agent(id: string, fields: Partial<ArrangeTile> = {}): ArrangeTile {
  return { id, name: id, kind: 'agent', role: null, issue: null, state: 'idle', reviewOf: null, lead: false, ...fields };
}

/** Where each tile went, as [column, row] of the zone's grid. */
function cells(positions: Map<string, Point>): Record<string, [number, number]> {
  return Object.fromEntries([...positions].map(([id, { x, y }]) => [id, [(x - FIRST.x) / COLUMN, (y - FIRST.y) / ROW_STEP]]));
}

/** Where each tile went, in px from the zone's top-left, as [x, y]. */
function px(positions: Map<string, Point>): Record<string, [number, number]> {
  return Object.fromEntries([...positions].map(([id, { x, y }]) => [id, [x, y]]));
}
/** Every part an arrange placed, as boxes: each tile at its size (its perch above it), each lane's label and note. */
function partsOf(arranged: ReturnType<typeof arrangeTiles>, tiles: readonly ArrangeTile[]): { id: string; rect: Rect }[] {
  return [
    ...tiles.map((tile) => ({ id: tile.id, rect: sizedFootprint(arranged.positions.get(tile.id)!, tile.size ?? AGENT_TILE_SIZE) })),
    ...arranged.clusters.flatMap((cluster) => [
      { id: `${cluster.key}#label`, rect: { ...cluster.labelAt, ...CLUSTER_LABEL_SIZE } },
      { id: `${cluster.key}#note`, rect: { ...cluster.noteAt, ...cluster.noteSize } },
    ]),
  ];
}

/**
 * The tiles not where an arrange puts things across: on one of the grid's columns, or packed a tile gap or a rail's room
 * right after another part (in any row: a column shared by rows starts past the widest of the one before). A loose check
 * of the shape only, blind to tiles drifting together: the exact px expected in the tests, and `spread`, pin the layout.
 */
function offGrid(arranged: ReturnType<typeof arrangeTiles>, tiles: readonly ArrangeTile[]): string[] {
  const parts = partsOf(arranged, tiles);
  return tiles
    .filter(({ id }) => {
      const { x } = arranged.positions.get(id)!;
      return !Number.isInteger((x - FIRST.x) / COLUMN) && !parts.some((part) => part.id !== id && [TILE_GAP, RAIL_GAP].includes(x - (part.rect.x + part.rect.width)));
    })
    .map(({ id }) => id);
}

/** Asserts no two of the placed tiles, nor any of them and an obstacle, come within a gap of each other. */
function expectClear(positions: Map<string, Point>, tiles: readonly ArrangeTile[], obstacles: readonly Rect[] = []) {
  const placed = tiles.map((tile) => sizedFootprint(positions.get(tile.id)!, tile.size ?? AGENT_TILE_SIZE));
  placed.forEach((rect, index) => expect(clearOf(rect, [...placed.filter((_, other) => other !== index), ...obstacles])).toBe(true));
}

/**
 * What is wrong with the rails between `links`' tiles as placed: two joined closer than a rail's room, across and down,
 * or a rail (a line between their middles) through another tile or the tile gap round it.
 */
function railTrouble(positions: Map<string, Point>, tiles: readonly ArrangeTile[], links: readonly { from: string; to: string }[]): string[] {
  const rect = (id: string) => ({ ...positions.get(id)!, ...(tiles.find((tile) => tile.id === id)!.size ?? AGENT_TILE_SIZE) });
  const middle = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  return links.flatMap(({ from, to }) => {
    const [a, b] = [rect(from), rect(to)];
    const across = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
    const down = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
    const close = Math.max(across, down) < RAIL_GAP ? [`${from}–${to} too close`] : [];
    const [p, q] = [middle(a), middle(b)];
    // Sampled along the line: fine enough for tiles hundreds of pixels across.
    const hit = tiles
      .filter(({ id }) => id !== from && id !== to)
      .filter(({ id }) => {
        const r = rect(id);
        return Array.from({ length: 101 }, (_, step) => ({ x: p.x + ((q.x - p.x) * step) / 100, y: p.y + ((q.y - p.y) * step) / 100 })).some(
          (at) => at.x > r.x - TILE_GAP && at.x < r.x + r.width + TILE_GAP && at.y > r.y - TILE_GAP && at.y < r.y + r.height + TILE_GAP,
        );
      })
      .map(({ id }) => `${from}–${to} crosses ${id}`);
    return [...close, ...hit];
  });
}

const crew: ArrangeTile[] = [
  agent('lead', { lead: true }),
  agent('impl-b', { role: 'implementer', issue: 'ACME-12' }),
  agent('review-a', { role: 'reviewer', reviewOf: 'impl-a' }),
  agent('impl-a', { role: 'implementer', issue: 'ACME-9' }),
  agent('review-b', { role: 'reviewer' }),
  agent('loner', { role: 'custom' }),
  { ...agent('notes'), kind: 'shell', state: null },
];
const edges = [
  { from: 'impl-b', to: 'review-b' },
  { from: 'review-b', to: 'impl-b' },
  // Edges to and from the lead never chain its crew into one row.
  { from: 'lead', to: 'impl-a' },
];

describe('arrangeTiles', () => {
  it('by issue, in rows: the lead and the shells first, then a row per issue with the implementer and its reviewer to its right', () => {
    const { positions } = arrangeTiles(crew, edges, { by: 'issue', layout: 'rows', width: 900 });
    // The rail between impl-b and review-b takes a rail's room in its own lane only; the lead's into impl-a a rail's
    // room above impl-a's lane. The lead's row lines up with none, so its shell sits beside it.
    expect(px(positions)).toEqual({
      lead: [20, 44],
      notes: [292, 44],
      'impl-a': [20, 396],
      'review-a': [292, 396],
      'impl-b': [20, 572],
      'review-b': [468, 572],
      loner: [20, 748],
    });
  });

  it("leaves a rail's room between tiles an edge joins, in their own lane, and none where no edge does", () => {
    const tiles = [
      agent('impl-a', { role: 'implementer', issue: 'ACME-9' }),
      agent('review-a', { role: 'reviewer', reviewOf: 'impl-a' }),
      agent('impl-b', { role: 'implementer', issue: 'ACME-12' }),
      agent('review-b', { role: 'reviewer', reviewOf: 'impl-b' }),
    ];
    const handBack = [
      { from: 'impl-a', to: 'review-a' },
      { from: 'review-a', to: 'impl-a' },
    ];
    const result = arrangeTiles(tiles, handBack, { by: 'issue', layout: 'rows', width: 900, clusters: true });
    const [implA, reviewA, implB, reviewB] = ['impl-a', 'review-a', 'impl-b', 'review-b'].map((id) => result.positions.get(id)!);
    // Exactly a rail's room: no more.
    expect(reviewA!.x - (implA!.x + AGENT_TILE_SIZE.width)).toBe(RAIL_GAP);
    expect(offGrid(result, tiles)).toEqual([]);
    // The other cluster, with no rail, keeps its reviewer on the grid right beside its implementer.
    expect(reviewB!.x).toBe(implB!.x + COLUMN);
    expect(implB!.x).toBe(implA!.x);
    // Unjoined, a reviewer sits right beside what it reviews.
    const apart = arrangeTiles(tiles, [], { by: 'issue', layout: 'rows', width: 900, clusters: true }).positions;
    expect(apart.get('review-a')!.x - apart.get('impl-a')!.x).toBe(COLUMN);
  });

  it("leaves a rail's room past every tile a rail runs by, not only between neighbours", () => {
    // One implementer, two reviewers, each joined to it: the second's rail runs past the first.
    const tiles = [
      agent('impl', { role: 'implementer', issue: 'ACME-9' }),
      agent('review', { role: 'reviewer', reviewOf: 'impl', createdAt: '1' }),
      agent('again', { role: 'reviewer', reviewOf: 'impl', createdAt: '2' }),
    ];
    const both = ['review', 'again'].flatMap((to) => [
      { from: 'impl', to },
      { from: to, to: 'impl' },
    ]);
    const result = arrangeTiles(tiles, both, { by: 'issue', layout: 'rows', width: 900, clusters: true });
    const [impl, review, again] = ['impl', 'review', 'again'].map((id) => result.positions.get(id)!);
    expect(review!.y).toBe(again!.y);
    // Whichever end the far rail's token is at, it lies in a rail's room: after impl, or before again.
    expect(review!.x - (impl!.x + AGENT_TILE_SIZE.width)).toBeGreaterThanOrEqual(RAIL_GAP);
    expect(again!.x - (review!.x + AGENT_TILE_SIZE.width)).toBeGreaterThanOrEqual(RAIL_GAP);
    expect(offGrid(result, tiles)).toEqual([]);
  });

  it("as a grid, leaves a rail's room between tiles an edge joins, as rows do, its line crossing no tile", () => {
    const tiles = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => agent(id, { createdAt: id }));
    const joined = [
      { from: 'a', to: 'c' },
      { from: 'b', to: 'e' },
    ];
    const result = arrangeTiles(tiles, joined, { by: 'state', layout: 'grid', width: 2 * ZONE_PADDING + 4 * COLUMN - TILE_GAP });
    const { positions } = result;
    expect(railTrouble(positions, tiles, joined)).toEqual([]);
    expect(offGrid(result, tiles)).toEqual([]);
    expectClear(positions, tiles);
  });

  /** Asserts the tiles of `block` are where rows put them, laid out alone, and that the others keep off them and their rails. */
  function expectRowsBlock(tiles: readonly ArrangeTile[], joined: readonly { from: string; to: string }[], block: readonly string[], width: number) {
    const result = arrangeTiles(tiles, joined, { by: 'issue', layout: 'grid', width });
    const { positions } = result;
    const alone = arrangeTiles(
      tiles.filter((tile) => block.includes(tile.id)),
      joined,
      { by: 'issue', layout: 'rows', width },
    ).positions;
    expect(Object.fromEntries(block.map((id) => [id, positions.get(id)]))).toEqual(Object.fromEntries(alone));
    const rect = (id: string) => sizedFootprint(positions.get(id)!, AGENT_TILE_SIZE);
    const railBoxes = joined.map(({ from, to }) => {
      const [a, b] = [rect(from), rect(to)];
      const [x, y] = [Math.min(a.x, b.x), Math.min(a.y, b.y)];
      return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
    });
    for (const tile of tiles.filter(({ id }) => !block.includes(id))) expect(clearOf(rect(tile.id), [...block.map(rect), ...railBoxes]), tile.id).toBe(true);
    expect(offGrid(result, tiles)).toEqual([]);
    expectClear(positions, tiles);
    return positions;
  }
  const columnsWide = (columns: number) => 2 * ZONE_PADDING + columns * COLUMN - TILE_GAP;
  const loose = (count: number) => Array.from({ length: count }, (_, index) => agent(`loose${index}`, { createdAt: `z${index}` }));

  it('as a grid, lays a lead joined to implementer–reviewer pairs out as rows do, the unjoined filling the grid round them', () => {
    const pairs = Array.from({ length: 4 }, (_, index) => index);
    const tiles = [
      agent('lead', { lead: true }),
      ...pairs.flatMap((index) => [
        agent(`impl${index}`, { role: 'implementer', issue: `ACME-${index + 1}` }),
        agent(`review${index}`, { role: 'reviewer', reviewOf: `impl${index}` }),
      ]),
      ...loose(6),
    ];
    const joined = pairs.flatMap((index) => [
      { from: 'lead', to: `impl${index}` },
      { from: `impl${index}`, to: `review${index}` },
      { from: `review${index}`, to: `impl${index}` },
    ]);
    const block = ['lead', ...pairs.flatMap((index) => [`impl${index}`, `review${index}`])];
    const positions = expectRowsBlock(tiles, joined, block, columnsWide(8));
    // A rail's room between each implementer and its reviewer.
    for (const index of pairs) expect(positions.get(`review${index}`)!.x - (positions.get(`impl${index}`)!.x + AGENT_TILE_SIZE.width)).toBeGreaterThanOrEqual(RAIL_GAP);
  });

  it('as a grid, lays a hub that is not the lead out as rows do, with its reviewers', () => {
    const reviewers = ['r1', 'r2', 'r3', 'r4', 'r5'];
    const tiles = [
      agent('lead', { lead: true }),
      agent('hub', { role: 'implementer', issue: 'ACME-9' }),
      ...reviewers.map((id) => agent(id, { role: 'reviewer', reviewOf: 'hub', createdAt: id })),
      ...loose(4),
    ];
    const joined = reviewers.flatMap((id) => [
      { from: 'hub', to: id },
      { from: id, to: 'hub' },
    ]);
    const positions = expectRowsBlock(tiles, joined, ['hub', ...reviewers], columnsWide(4));
    // One row, a rail's room after each tile, so every rail's token has room at either end.
    const row = ['hub', ...reviewers].map((id) => positions.get(id)!);
    expect(new Set(row.map(({ y }) => y)).size).toBe(1);
    row.slice(1).forEach((at, index) => expect(at.x - (row[index]!.x + AGENT_TILE_SIZE.width)).toBeGreaterThanOrEqual(RAIL_GAP));
  });

  it('as a grid, keeps the zone as tall as the rows of its joined units and the grid of the rest need, no more', () => {
    const pairs = Array.from({ length: 10 }, (_, index) => index);
    const tiles = [
      agent('lead', { lead: true }),
      ...pairs.flatMap((index) => [agent(`impl${index}`, { role: 'implementer', issue: `ACME-${index + 1}` }), agent(`review${index}`, { role: 'reviewer', reviewOf: `impl${index}` })]),
      ...loose(20),
    ];
    const joined = pairs.flatMap((index) => [
      { from: 'lead', to: `impl${index}` },
      { from: `impl${index}`, to: `review${index}` },
    ]);
    for (const columns of [3, 8]) {
      const { size } = arrangeTiles(tiles, joined, { by: 'issue', layout: 'grid', width: columnsWide(columns) });
      // The lead's row, each pair's row with a rail's row above it, and the loose ones in the columns beside or below.
      const rows = 1 + pairs.length * (1 + 1) + Math.ceil(20 / columns);
      expect(size.height, `${columns} columns`).toBeLessThanOrEqual(GRID_ROW_TOP + rows * ROW_STEP + ZONE_PADDING);
    }
  });

  it("leaves a rail's room between rows an edge runs between", () => {
    const tiles = [agent('impl', { role: 'implementer' }), agent('review', { role: 'reviewer', reviewOf: 'impl' })];
    const { positions } = arrangeTiles(tiles, [{ from: 'impl', to: 'review' }], { by: 'role', layout: 'rows', width: 900 });
    const [impl, review] = [positions.get('impl')!, positions.get('review')!];
    expect(review.x).toBe(impl.x);
    // Exactly a rail's room to the characters perched on the lower tile: no more.
    expect(review.y - (impl.y + AGENT_TILE_SIZE.height)).toBe(RAIL_GAP + PERCH_ROOM);
    const apart = arrangeTiles(tiles, [], { by: 'role', layout: 'rows', width: 900 }).positions;
    expect(apart.get('review')!.y - apart.get('impl')!.y).toBe(ROW_STEP);
  });

  it('is the same whatever order the tiles and edges come in', () => {
    const first = arrangeTiles(crew, edges, { by: 'issue', layout: 'rows', width: 900, clusters: true });
    const again = arrangeTiles(crew.toReversed(), edges.toReversed(), { by: 'issue', layout: 'rows', width: 900, clusters: true });
    expect([...again.positions].sort()).toEqual([...first.positions].sort());
    expect(again.clusters).toEqual(first.clusters);
    expect(again.size).toEqual(first.size);
  });

  it('by role, puts each role on its row and a reviewer under the implementer it reviews', () => {
    const { positions } = arrangeTiles(crew, edges, { by: 'role', layout: 'rows', width: 900 });
    // The lead's edge into impl-a runs between their rows, and impl-b's with review-b past the loner's: a rail's room
    // above each row they cross.
    expect(px(positions)).toEqual({
      lead: [20, 44],
      'impl-a': [20, 396],
      'impl-b': [292, 396],
      loner: [564, 748],
      'review-a': [20, 1100],
      'review-b': [292, 1100],
      notes: [20, 1276],
    });
  });

  it('by role, puts a reviewer under what it reviews whatever that one’s role, its row first', () => {
    const tiles = [
      agent('watchdog', { role: 'custom', createdAt: '2026-10-15T20:00:00Z' }),
      agent('review', { role: 'reviewer', reviewOf: 'watchdog', createdAt: '2026-10-15T21:00:00Z' }),
      agent('other', { role: 'custom', createdAt: '2026-10-15T19:00:00Z' }),
    ];
    const { positions } = arrangeTiles(tiles, [], { by: 'role', layout: 'rows', width: 900 });
    const at = cells(positions);
    expect(at.review![1]).toBeGreaterThan(at.watchdog![1]);
    expect(at.review![0]).toBe(at.watchdog![0]);
  });

  it('by state, a row per state, the ones needing the user first', () => {
    const tiles = [agent('busy', { state: 'running' }), agent('asks', { state: 'needs-permission' }), agent('done', { state: 'done' })];
    expect(cells(arrangeTiles(tiles, [], { by: 'state', layout: 'rows', width: 900 }).positions)).toEqual({ asks: [0, 0], busy: [0, 1], done: [0, 2] });
  });

  it('as a grid, fills the zone row by row in the same order', () => {
    const { positions } = arrangeTiles(crew, edges, { by: 'issue', layout: 'grid', width: 2 * ZONE_PADDING + 3 * COLUMN - TILE_GAP });
    // The units edges join (the lead's with impl-a, and both issues') as rows lay them out; the rest fill the grid
    // round them, clear of their rails, the shells first as they share the lead's row.
    expect(px(positions)).toEqual({
      lead: [20, 44],
      'impl-a': [20, 396],
      'review-a': [292, 396],
      'impl-b': [20, 572],
      'review-b': [468, 572],
      notes: [292, 44],
      loner: [564, 44],
    });
    expect(railTrouble(positions, crew, edges)).toEqual([]);
  });

  it('keeps a row clear of what it may not move, moving the whole row down just past it', () => {
    // Where review-a would go, below the rail's room over its lane.
    const note: Rect = { x: FIRST.x + COLUMN, y: 400, width: 200, height: 200 };
    const result = arrangeTiles(crew, edges, { by: 'issue', layout: 'rows', width: 900, obstacles: [note] });
    const { positions } = result;
    expectClear(positions, crew, [note]);
    expect(positions.get('impl-a')!.y).toBe(positions.get('review-a')!.y);
    // A tile gap below it, the tile's perch above the tile: not down to the next grid row.
    expect(positions.get('impl-a')!.y).toBe(note.y + note.height + TILE_GAP + PERCH_ROOM);
    expect(offGrid(result, crew)).toEqual([]);
  });

  it('lays resized tiles out at their size, what follows in their lane a tile gap past them, and says how big the zone must be', () => {
    const big = agent('impl-a', { role: 'implementer', issue: 'ACME-9', size: { width: 480, height: 300 } });
    const tiles = [...crew.filter((tile) => tile.id !== 'impl-a'), big];
    const result = arrangeTiles(tiles, edges, { by: 'issue', layout: 'rows', width: 300 });
    const { positions, size } = result;
    expectClear(positions, tiles);
    expect(offGrid(result, tiles)).toEqual([]);
    // Its reviewer right past it; the other lane's a rail's room past its own implementer.
    expect(positions.get('review-a')!.x).toBe(FIRST.x + 480 + TILE_GAP);
    expect(positions.get('review-b')!.x).toBe(FIRST.x + AGENT_TILE_SIZE.width + RAIL_GAP);
    const right = Math.max(...tiles.map((tile) => positions.get(tile.id)!.x + (tile.size ?? AGENT_TILE_SIZE).width));
    const bottom = Math.max(...tiles.map((tile) => positions.get(tile.id)!.y + (tile.size ?? AGENT_TILE_SIZE).height));
    expect(size.width).toBe(right + ZONE_PADDING);
    expect(size.height).toBe(bottom + TILE_GAP + ZONE_PADDING);
  });

  it('places nothing for no tiles', () => {
    expect(arrangeTiles([], [], { by: 'issue', layout: 'rows', width: 600 }).positions.size).toBe(0);
  });

  it('puts every tile on the grid across, or packed past another, whatever it is arranged by and however laid out', () => {
    const note: Rect = { x: 333, y: 91, width: 157, height: 211 };
    const big = agent('big', { size: { width: 301, height: 180 } });
    for (const by of ['issue', 'role', 'state'] as const) {
      for (const layout of ['rows', 'columns', 'cards', 'grid'] as const) {
        const tiles = [...crew, big];
        const result = arrangeTiles(tiles, edges, { by, layout, width: 1000, obstacles: [note], clusters: true });
        const { positions, clusters } = result;
        expect(offGrid(result, tiles), `${by} ${layout}`).toEqual([]);
        expect(positions.size).toBe(tiles.length);
        // Nothing on top of another, nor of what it may not move: the tiles, and each lane's label and note.
        const parts = [
          ...tiles.map((tile) => sizedFootprint(positions.get(tile.id)!, tile.size ?? AGENT_TILE_SIZE)),
          ...clusters.flatMap((cluster) => [
            { ...cluster.labelAt, ...CLUSTER_LABEL_SIZE },
            { ...cluster.noteAt, ...cluster.noteSize },
          ]),
        ];
        parts.forEach((rect, index) => expect(clearOf(rect, [...parts.filter((_, other) => other !== index), note]), `${by} ${layout}`).toBe(true));
        expect(railTrouble(positions, tiles, edges), `${by} ${layout}`).toEqual([]);
      }
    }
  });
});

describe('the order of a unit of work', () => {
  // Joined by an edge, the second is a rail's room to the right of the first.
  const both = (a: string, b: string) => [
    { from: a, to: b },
    { from: b, to: a },
  ];

  it('puts the implementer before its reviewer when edges join them both ways, whatever their names', () => {
    // As first seen on a real zone: the reviewer's name sorts first, and the implementer's role is custom.
    const tiles = [
      agent('impl', { name: 'ACME-199 test watchdog', role: 'custom', createdAt: '2026-10-15T20:00:00Z' }),
      agent('review', { name: 'ACME-199 review #185', role: 'reviewer', reviewOf: 'impl', createdAt: '2026-10-15T21:00:00Z' }),
    ];
    const { positions } = arrangeTiles(tiles, both('impl', 'review'), { by: 'issue', layout: 'rows', width: 900 });
    expect(px(positions)).toEqual({ impl: [20, 44], review: [468, 44] });
  });

  it('follows what a reviewer reviews over any edge back to it', () => {
    const tiles = [agent('impl', { role: 'custom' }), agent('review', { role: 'custom', reviewOf: 'impl' })];
    const { positions } = arrangeTiles(tiles, [{ from: 'review', to: 'impl' }], { by: 'issue', layout: 'rows', width: 900 });
    expect(px(positions)).toEqual({ impl: [20, 44], review: [468, 44] });
  });

  it('with edges both ways and no reviewer, puts an implementer first, else the one started first', () => {
    const byRole = [agent('b', { role: 'implementer', createdAt: '2' }), agent('a', { role: 'custom', createdAt: '1' })];
    expect(px(arrangeTiles(byRole, both('a', 'b'), { by: 'issue', layout: 'rows', width: 900 }).positions)).toEqual({ b: [20, 44], a: [468, 44] });
    const bySpawn = [agent('a', { role: 'custom', createdAt: '2' }), agent('b', { role: 'custom', createdAt: '1' })];
    expect(px(arrangeTiles(bySpawn, both('a', 'b'), { by: 'issue', layout: 'rows', width: 900 }).positions)).toEqual({ b: [20, 44], a: [468, 44] });
  });
});

describe('arranging a crowded zone', () => {
  it('lays rows out below what fills the zone, and returns', () => {
    const wall: Rect = { x: 0, y: 0, width: 5000, height: 3000 };
    const many = Array.from({ length: 40 }, (_, index) => agent(`a${index}`));
    for (const layout of ['rows', 'grid'] as const) {
      const result = arrangeTiles(many, [], { by: 'issue', layout, width: 600, obstacles: [wall] });
      expect(result.positions.size).toBe(40);
      expectClear(result.positions, many, [wall]);
      expect(offGrid(result, many)).toEqual([]);
    }
  });
});

describe('arranging at a spacing', () => {
  // A busy zone: the lead, then three lanes of an implementer and the reviewer an edge joins it to, each with its note.
  const busy: ArrangeTile[] = [
    agent('lead', { lead: true }),
    ...[9, 12, 15].flatMap((n) => [
      agent(`impl-${n}`, { role: 'implementer', issue: `ACME-${n}` }),
      agent(`review-${n}`, { role: 'reviewer', reviewOf: `impl-${n}` }),
    ]),
  ];
  const links = [9, 12, 15].map((n) => ({ from: `impl-${n}`, to: `review-${n}` }));
  const { width, height } = AGENT_TILE_SIZE;

  it.each(ARRANGE_SPACINGS)('%s: the zone padding, rail, tile gap and lane gap its spacing says', (spacing) => {
    const gaps = SPACING_GAPS[spacing];
    const { positions, clusters, size } = arrangeTiles(busy, links, { by: 'issue', layout: 'rows', width: 600, clusters: true, spacing });
    const at = (id: string) => positions.get(id)!;
    // The lead at the zone's top-left, its padding and its perch in from the edge; each lane's label at its padding.
    expect(at('lead')).toEqual({ x: gaps.padding, y: gaps.padding + PERCH_ROOM });
    for (const cluster of clusters) expect(cluster.labelAt.x).toBe(gaps.padding);
    // Along a lane: a rail's room between the pair, a tile gap to the note.
    expect(at('review-9').x - (at('impl-9').x + width)).toBe(gaps.rail);
    expect(clusters[0]!.noteAt.x - (at('review-9').x + width)).toBe(gaps.tile);
    // A lane gap below the top row and below each lane, the perch in it.
    expect(at('impl-9').y - (at('lead').y + height)).toBe(gaps.lane);
    expect(at('impl-12').y - (at('impl-9').y + height)).toBe(gaps.lane);
    expect(at('impl-15').y - (at('impl-12').y + height)).toBe(gaps.lane);
    // The lanes line up, and the zone ends its padding past the last note.
    expect(new Set(['impl-9', 'impl-12', 'impl-15'].map((id) => at(id).x)).size).toBe(1);
    expect(size.width).toBe(clusters[0]!.noteAt.x + CLUSTER_NOTE_SIZE.width + gaps.padding);
    expect(size.height).toBe(at('impl-15').y + height + gaps.tile + gaps.padding);
  });

  it('at normal spacing, puts the busy zone exactly where it always went', () => {
    expect(SPACING_GAPS.normal).toEqual({ tile: 16, lane: 40, padding: 20, rail: 192 });
    for (const spacing of ['normal', undefined] as const) {
      const { positions, clusters, size } = arrangeTiles(busy, links, { by: 'issue', layout: 'rows', width: 600, clusters: true, ...(spacing === undefined ? {} : { spacing }) });
      expect(px(positions)).toEqual({
        lead: [20, 44],
        'impl-9': [292, 220],
        'review-9': [740, 220],
        'impl-12': [292, 396],
        'review-12': [740, 396],
        'impl-15': [292, 572],
        'review-15': [740, 572],
      });
      expect(clusters.map((cluster) => [cluster.labelAt, cluster.noteAt])).toEqual([220, 396, 572].map((y) => [{ x: 20, y }, { x: 1012, y }]));
      expect(size).toEqual({ width: 1288, height: 744 });
    }
  });

  it('keeps tiles in a row on the dots, a tile gap or 16 px apart, whichever is more', () => {
    const pair = [agent('impl-a', { role: 'implementer', issue: 'ACME-9' }), agent('impl-b', { role: 'implementer', issue: 'ACME-9' })];
    const gapAt = (spacing: (typeof ARRANGE_SPACINGS)[number]) => {
      const { positions } = arrangeTiles(pair, [], { by: 'issue', layout: 'rows', width: 600, spacing });
      return positions.get('impl-b')!.x - (positions.get('impl-a')!.x + width);
    };
    expect([gapAt('compact'), gapAt('normal'), gapAt('roomy')]).toEqual([16, 16, 32]);
  });

  it("leaves a rail's room between rows a rail crosses, at the spacing's rail", () => {
    // By state, an edge joins tiles in two rows.
    const tiles = [agent('a', { state: 'waiting' }), agent('b', { state: 'idle' })];
    for (const spacing of ARRANGE_SPACINGS) {
      const { positions } = arrangeTiles(tiles, [{ from: 'a', to: 'b' }], { by: 'state', layout: 'rows', width: 600, spacing });
      // From the upper tile's bottom to the lower one's perch.
      expect(positions.get('b')!.y - PERCH_ROOM - (positions.get('a')!.y + height)).toBe(SPACING_GAPS[spacing].rail);
    }
  });

  it('as a grid, fills each row of its spacing, none skipped', () => {
    const loose = ['a', 'b', 'c', 'd'].map((id) => agent(id));
    for (const spacing of ARRANGE_SPACINGS) {
      const { positions } = arrangeTiles(loose, [], { by: 'issue', layout: 'grid', width: 640, spacing });
      // Two to a row: the third starts the next row, a tile and a lane gap below the first.
      expect(positions.get('c')!.y - positions.get('a')!.y).toBe(height + SPACING_GAPS[spacing].lane);
    }
  });

  it.each(['columns', 'cards', 'grid'] as const)('in %s, starts at the spacing\'s padding and keeps its gaps', (layout) => {
    for (const spacing of ARRANGE_SPACINGS) {
      const gaps = SPACING_GAPS[spacing];
      const { positions } = arrangeTiles(busy, links, { by: 'issue', layout, width: 1400, clusters: layout !== 'grid', spacing });
      const rects = busy.map((tile) => ({ x: positions.get(tile.id)!.x, y: positions.get(tile.id)!.y, width, height }));
      expect(Math.min(...rects.map((rect) => rect.x))).toBe(gaps.padding);
      expect(Math.min(...rects.map((rect) => rect.y))).toBe(gaps.padding + PERCH_ROOM);
      // No two tiles closer than its tile gap across, or its lane gap down.
      for (const a of rects) {
        for (const b of rects) {
          if (a === b) continue;
          const apart = Math.max(b.x - (a.x + width), b.y - (a.y + height) - (gaps.lane - gaps.tile));
          if (b.x >= a.x && b.y >= a.y) expect(apart).toBeGreaterThanOrEqual(gaps.tile);
        }
      }
    }
  });
});

describe('arranging as clusters', () => {
  const work: ArrangeTile[] = [
    agent('lead', { lead: true }),
    agent('impl-a', { role: 'implementer', issue: 'ACME-9', issueTitle: 'Menu scroll' }),
    agent('review-a', { role: 'reviewer', reviewOf: 'impl-a' }),
    agent('loner', { role: 'custom' }),
  ];

  it('gives each unit of work a label in the column before its tiles, then its tiles, left to right, then its note', () => {
    const { positions, clusters, size } = arrangeTiles(work, [], { by: 'issue', layout: 'rows', width: 600, clusters: true });
    expect(clusters.map(({ key, label, members }) => ({ key, label, members }))).toEqual([
      { key: 'issue:ACME-9', label: 'ACME-9 Menu scroll', members: ['impl-a', 'review-a'] },
      { key: 'loner', label: 'loner', members: ['loner'] },
    ]);
    const [menu] = clusters;
    const impl = positions.get('impl-a')!;
    expect(cells(positions)['impl-a']).toEqual([1, 1]);
    expect(cells(positions)['review-a']).toEqual([2, 1]);
    expect(menu!.labelAt).toEqual({ x: FIRST.x, y: impl.y });
    // The note is in its row, in the column after its reviewer.
    expect(menu!.noteAt).toEqual({ x: positions.get('review-a')!.x + COLUMN, y: impl.y });
    // Nothing after its note: the zone ends there.
    expect(size.width).toBe(menu!.noteAt.x + CLUSTER_NOTE_SIZE.width + ZONE_PADDING);
    // The lead keeps its own row, unlabelled, above them all.
    expect(cells(positions).lead).toEqual([0, 0]);
  });

  it('lines clusters up: implementers in one column, reviewers in the next', () => {
    const tiles = [
      agent('impl-a', { role: 'implementer', issue: 'ACME-9' }),
      agent('review-a', { role: 'reviewer', reviewOf: 'impl-a' }),
      agent('again-a', { role: 'follow-up-reviewer', reviewOf: 'impl-a' }),
      agent('impl-b', { role: 'implementer', issue: 'ACME-12' }),
      agent('review-b', { role: 'reviewer', reviewOf: 'impl-b' }),
    ];
    const { positions } = arrangeTiles(tiles, [], { by: 'issue', layout: 'rows', width: 900, clusters: true });
    const at = cells(positions);
    expect(at['impl-a']![0]).toBe(at['impl-b']![0]);
    expect(at['review-a']![0]).toBe(at['review-b']![0]);
    // Rows a fixed pitch apart.
    expect(at['impl-b']![1] - at['impl-a']![1]).toBe(1);
  });

  it('labels a unit without an issue by the ticket in its branch, and puts units of one ticket together', () => {
    const tiles = [
      agent('impl', { name: 'test watchdog', role: 'custom', branch: 'someone/acme-199-test-watchdog', createdAt: '1' }),
      agent('review', { name: 'review #185', role: 'reviewer', reviewOf: 'impl', branch: 'someone/acme-199-test-watchdog' }),
      agent('docs', { name: 'docs', role: 'custom', branch: 'acme-199-docs', createdAt: '3' }),
    ];
    const { clusters } = arrangeTiles(tiles, [], { by: 'issue', layout: 'rows', width: 900, clusters: true });
    expect(clusters.map(({ key, label, members }) => ({ key, label, members }))).toEqual([{ key: 'issue:ACME-199', label: 'ACME-199', members: ['impl', 'docs', 'review'] }]);
  });

  it('labels one without a ticket by the words its agents’ names start with, else by its implementer’s name', () => {
    const shared = [agent('impl', { name: 'Menu fix: build', role: 'implementer' }), agent('review', { name: 'Menu fix: review', reviewOf: 'impl' })];
    expect(arrangeTiles(shared, [], { by: 'issue', layout: 'rows', width: 900, clusters: true }).clusters[0]!.label).toBe('Menu fix');
    const apart = [agent('impl', { name: 'builder', role: 'implementer' }), agent('review', { name: 'checker', reviewOf: 'impl' })];
    expect(arrangeTiles(apart, [], { by: 'issue', layout: 'rows', width: 900, clusters: true }).clusters[0]!.label).toBe('builder');
  });

  it('cuts a long label to fit its column, never splitting an emoji', () => {
    const tiles = [agent('impl', { issue: 'ACME-9', issueTitle: `Make the menu scroll ${'🤖'.repeat(40)}` })];
    const [cluster] = arrangeTiles(tiles, [], { by: 'issue', layout: 'rows', width: 900, clusters: true }).clusters;
    expect(cluster!.label.endsWith('…')).toBe(true);
    expect(JSON.stringify(cluster!.label)).not.toMatch(/\\ud8/);
  });

  it('keeps every part of every cluster clear of each other and of what it may not move', () => {
    const note: Rect = { x: 300, y: 200, width: 200, height: 200 };
    const { positions, clusters } = arrangeTiles(work, [], { by: 'issue', layout: 'rows', width: 900, clusters: true, obstacles: [note] });
    const parts = [
      ...work.map((tile) => sizedFootprint(positions.get(tile.id)!, AGENT_TILE_SIZE)),
      ...clusters.flatMap((cluster) => [
        { ...cluster.labelAt, ...CLUSTER_LABEL_SIZE },
        { ...cluster.noteAt, ...CLUSTER_NOTE_SIZE },
      ]),
    ];
    parts.forEach((rect, index) => expect(clearOf(rect, [...parts.filter((_, other) => other !== index), note])).toBe(true));
  });

  it('lays out no clusters by role or state, nor as a grid', () => {
    expect(arrangeTiles(work, [], { by: 'issue', layout: 'columns', width: 900, clusters: true }).clusters).toHaveLength(2);
    for (const options of [{ by: 'role', layout: 'rows' }, { by: 'state', layout: 'rows' }, { by: 'issue', layout: 'grid' }] as const) {
      expect(arrangeTiles(work, [], { ...options, width: 900, clusters: true }).clusters).toEqual([]);
    }
  });
});

describe('arranging in lanes', () => {
  const lanes: ArrangeTile[] = [
    agent('lead', { lead: true }),
    { ...agent('gate'), kind: 'shell', state: null },
    agent('impl-a', { role: 'implementer', issue: 'ACME-9' }),
    agent('review-a', { role: 'reviewer', reviewOf: 'impl-a' }),
    agent('again-a', { role: 'follow-up-reviewer', reviewOf: 'impl-a' }),
    agent('impl-b', { role: 'implementer', issue: 'ACME-12' }),
  ];
  const arranged = (tiles: readonly ArrangeTile[], options: Partial<Parameters<typeof arrangeTiles>[2]> = {}) =>
    arrangeTiles(tiles, [], { by: 'issue', layout: 'rows', width: 600, clusters: true, ...options });
  const column = (point: Point) => (point.x - FIRST.x) / COLUMN;

  it('gives a lane with a tall note as much height as its note takes, the next lane a tile gap below it', () => {
    const { positions, clusters } = arranged(lanes, { noteHeights: new Map([['issue:ACME-9', 300]]) });
    const a = clusters.find((cluster) => cluster.key === 'issue:ACME-9')!;
    expect(a.noteSize).toEqual({ width: CLUSTER_NOTE_SIZE.width, height: 300 });
    expect(positions.get('impl-b')!.y - PERCH_ROOM).toBe(a.noteAt.y + 300 + TILE_GAP);
    // A short note keeps its slot's size.
    expect(clusters.find((cluster) => cluster.key === 'issue:ACME-12')!.noteSize).toEqual(CLUSTER_NOTE_SIZE);
  });

  it('puts the lead and the shells on the top row, then a lane per issue', () => {
    const at = cells(arranged(lanes).positions);
    expect(at.lead).toEqual([0, 0]);
    expect(at.gate).toEqual([1, 0]);
    expect(at['impl-a']![1]).toBe(1);
    expect(at['impl-b']![1]).toBe(2);
  });

  it('gives each lane its label, then a column per slot (implementer, reviewer, follow-up), then its note after its last tile', () => {
    const { positions, clusters } = arranged(lanes);
    const at = cells(positions);
    expect([at['impl-a']![0], at['review-a']![0], at['again-a']![0]]).toEqual([1, 2, 3]);
    const [a, b] = clusters;
    expect(column(a!.labelAt)).toBe(0);
    expect(column(a!.noteAt)).toBe(4);
    expect(a!.noteAt.y).toBe(positions.get('impl-a')!.y);
    // A short lane keeps its tiles in their slots' columns, its note right after its last tile: no run of free slots before it.
    expect(at['impl-b']![0]).toBe(1);
    expect(column(b!.noteAt)).toBe(2);
  });

  it('keeps lanes in the order their work started, so a lower-numbered ticket started later goes last', () => {
    const tiles = [
      agent('impl-b', { role: 'implementer', issue: 'ACME-12', createdAt: '1' }),
      agent('impl-a', { role: 'implementer', issue: 'ACME-9', createdAt: '2' }),
      agent('late', { role: 'implementer', issue: 'ACME-5', createdAt: '3' }),
      agent('review-late', { role: 'reviewer', reviewOf: 'late', createdAt: '4' }),
    ];
    expect(arranged(tiles).clusters.map((cluster) => cluster.key)).toEqual(['issue:ACME-12', 'issue:ACME-9', 'issue:ACME-5']);
  });

  it('drops a slot no lane uses, so no lane has a hole there', () => {
    const { clusters } = arranged(lanes.filter((tile) => tile.id !== 'again-a'));
    expect(clusters.map((cluster) => column(cluster.noteAt))).toEqual([3, 2]);
  });

  it('gives a second reviewer of one lane a column of its own in the reviewer slot, before the follow-up', () => {
    const at = cells(arranged([...lanes, agent('review-a2', { role: 'reviewer', reviewOf: 'impl-a', createdAt: '9' })]).positions);
    expect([at['review-a']![0], at['review-a2']![0], at['again-a']![0]]).toEqual([2, 3, 4]);
  });

  it('measures a resized or expanded tile at its size: its lane is taller and its column wider, in its lane only', () => {
    const big = { width: 2 * COLUMN + AGENT_TILE_SIZE.width, height: 2 * ROW_STEP + AGENT_TILE_SIZE.height };
    const tiles = lanes.map((tile) => (tile.id === 'impl-a' ? { ...tile, size: big } : tile));
    const { positions, clusters } = arranged(tiles);
    const at = cells(positions);
    expect(at['review-a']![0]).toBe(4);
    expect(at['impl-b']![0]).toBe(1);
    expect(at['impl-b']![1]).toBe(4);
    // The next lane's note right after its own tile, not past the big one.
    expect(column(clusters[1]!.noteAt)).toBe(2);
    expectClear(positions, tiles);
  });

  it('fits the zone to what it laid out, shrinking it as well as growing it', () => {
    const { clusters, size } = arranged(lanes, { width: 4000 });
    expect(size.width).toBe(clusters[0]!.noteAt.x + CLUSTER_NOTE_SIZE.width + ZONE_PADDING);
    const bottom = Math.max(...clusters.map((cluster) => cluster.noteAt.y + CLUSTER_NOTE_SIZE.height));
    expect(size.height).toBe(bottom + TILE_GAP + ZONE_PADDING);
  });

  it('keeps the zone big enough for what it may not move', () => {
    const note: Rect = { x: 3000, y: 20, width: 200, height: 200 };
    expect(arranged(lanes, { width: 4000, obstacles: [note] }).size.width).toBe(3200 + ZONE_PADDING);
  });
});

describe('arranging lanes as columns or cards', () => {
  const lanes: ArrangeTile[] = [
    agent('lead', { lead: true }),
    { ...agent('gate'), kind: 'shell', state: null },
    agent('impl-a', { role: 'implementer', issue: 'ACME-9' }),
    agent('review-a', { role: 'reviewer', reviewOf: 'impl-a' }),
    agent('again-a', { role: 'follow-up-reviewer', reviewOf: 'impl-a' }),
    agent('impl-b', { role: 'implementer', issue: 'ACME-12' }),
    agent('impl-c', { role: 'implementer', issue: 'ACME-14' }),
  ];
  const arranged = (layout: 'columns' | 'cards', tiles: readonly ArrangeTile[] = lanes, links: { from: string; to: string }[] = []) =>
    arrangeTiles(tiles, links, { by: 'issue', layout, width: 600, clusters: true });

  it('as columns: the lead and shells stacked first, then a column per lane, its label and note on top, its tiles under them in slot order', () => {
    const { positions, clusters } = arranged('columns');
    const at = cells(positions);
    expect([at.lead, at.gate]).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect([at['impl-a'], at['review-a'], at['again-a']]).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
    ]);
    expect([at['impl-b'], at['impl-c']]).toEqual([
      [2, 1],
      [3, 1],
    ]);
    expect(clusters.map((cluster) => cells(new Map([['label', cluster.labelAt]])).label)).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    // The note below its label, both in the head cell.
    const [a] = clusters;
    expect(a!.noteAt.y + a!.noteSize.height).toBe(a!.labelAt.y + AGENT_TILE_SIZE.height);
  });

  it('as columns or cards, makes a lane’s head as tall as its label and a note as tall as its text needs', () => {
    for (const layout of ['columns', 'cards'] as const) {
      const { positions, clusters } = arrangeTiles(lanes, [], { by: 'issue', layout, width: 1000, clusters: true, noteHeights: new Map([['issue:ACME-9', 300]]) });
      const a = clusters.find((cluster) => cluster.key === 'issue:ACME-9')!;
      expect(a.noteSize, layout).toEqual({ width: AGENT_TILE_SIZE.width, height: 300 });
      expect(a.noteAt.y, layout).toBe(a.labelAt.y + CLUSTER_LABEL_SIZE.height + TILE_GAP);
      // Nothing under it, nor in its row, comes before its note's end.
      const below = lanes.map((tile) => positions.get(tile.id)!).filter((point) => point.y > a.labelAt.y);
      for (const point of below) expect(point.y - PERCH_ROOM, layout).toBeGreaterThanOrEqual(a.noteAt.y + 300 + TILE_GAP);
      // A lane with a short note keeps the head a tile's size.
      expect(clusters.find((cluster) => cluster.key !== 'issue:ACME-9')!.noteSize.height, layout).toBe(AGENT_TILE_SIZE.height - CLUSTER_LABEL_SIZE.height - TILE_GAP);
    }
  });

  it('as columns, leaves a rail’s room between an implementer and the reviewer under it that an edge joins', () => {
    const links = [{ from: 'impl-a', to: 'review-a' }];
    const { positions } = arranged('columns', lanes, links);
    expect(positions.get('review-a')!.y - (positions.get('impl-a')!.y + AGENT_TILE_SIZE.height)).toBe(RAIL_GAP + PERCH_ROOM);
    expect(railTrouble(positions, lanes, links)).toEqual([]);
  });

  it('as cards: two across below the lead’s row, the head, implementer and reviewer on the first row, the follow-up under them', () => {
    const { positions, clusters } = arranged('cards');
    const at = cells(positions);
    expect([at.lead, at.gate]).toEqual([
      [0, 0],
      [1, 0],
    ]);
    // ACME-9's card: head, impl, reviewer; its follow-up under the implementer. Three columns wide, as every card.
    expect(cells(new Map([['label', clusters[0]!.labelAt]])).label).toEqual([0, 1]);
    expect([at['impl-a'], at['review-a'], at['again-a']]).toEqual([
      [1, 1],
      [2, 1],
      [1, 2],
    ]);
    // ACME-12 beside it, past a free column; ACME-14 on the next row of cards, past a free row.
    expect(cells(new Map([['label', clusters[1]!.labelAt]])).label).toEqual([4, 1]);
    expect(at['impl-b']).toEqual([5, 1]);
    expect(cells(new Map([['label', clusters[2]!.labelAt]])).label).toEqual([0, 4]);
    expect(at['impl-c']).toEqual([1, 4]);
  });

  it('as cards, flows three across past four lanes', () => {
    const many = [...lanes, ...['ACME-20', 'ACME-21'].map((issue) => agent(issue, { role: 'implementer', issue }))];
    const { clusters } = arranged('cards', many);
    expect(clusters.map((cluster) => cells(new Map([['label', cluster.labelAt]])).label![1])).toEqual([1, 1, 1, 4, 4]);
  });
});

describe('ticketOfBranch', () => {
  it('reads the ticket a branch is named for, with or without a user prefix', () => {
    expect(ticketOfBranch('acme-199-test-watchdog')).toBe('ACME-199');
    expect(ticketOfBranch('someone/acme-215-arrange')).toBe('ACME-215');
    expect(ticketOfBranch('ACME-12')).toBe('ACME-12');
  });

  it("never reads one from an agent's own branch suffix, nor from none", () => {
    // agent-board names an agent's branch its name and six random hex digits, which can all be digits.
    expect(ticketOfBranch('impl-123456')).toBeNull();
    expect(ticketOfBranch('main')).toBeNull();
    expect(ticketOfBranch('')).toBeNull();
    expect(ticketOfBranch(null)).toBeNull();
  });
});

describe('parking the clusters of an arrange by issue', () => {
  it('lines their parts up in rows on the grid from the cell given, clear of what may not move', () => {
    const wall: Rect = { x: FIRST.x + COLUMN, y: 0, width: 200, height: FIRST.y + 100 };
    const parked = parkClusters(['issue:ACME-9', 'issue:ACME-12'], { column: 1, row: 0 }, [wall]);
    expect(parked.map(({ key }) => key)).toEqual(['issue:ACME-9', 'issue:ACME-12']);
    for (const cluster of parked) {
      expect(cells(new Map([['label', cluster.labelAt]])).label!.every(Number.isInteger)).toBe(true);
      expect(cluster.labelAt.x).toBe(FIRST.x + COLUMN);
      // Its note beside its label, in the next column of its row.
      expect(cluster.noteAt).toEqual({ x: cluster.labelAt.x + COLUMN, y: cluster.labelAt.y });
      const parts = [{ ...cluster.labelAt, ...CLUSTER_LABEL_SIZE }, { ...cluster.noteAt, ...CLUSTER_NOTE_SIZE }];
      expect(parts.every((rect) => clearOf(rect, [wall]))).toBe(true);
    }
    // The wall takes the first row's cell: the first cluster goes a row down.
    expect(parked[0]!.labelAt.y).toBe(FIRST.y + ROW_STEP);
    expect(parked[1]!.labelAt.y).toBeGreaterThan(parked[0]!.labelAt.y);
  });

  it('parks a tall note in as many grid rows as it takes, the next cluster below it', () => {
    const parked = parkClusters(['tall', 'next'], { column: 0, row: 0 }, [], (key) => (key === 'tall' ? { width: 256, height: 300 } : CLUSTER_NOTE_SIZE));
    expect(parked[1]!.labelAt.y - parked[0]!.labelAt.y).toBe(2 * ROW_STEP);
  });

  it('parks from a row below the crew as readily as beside it', () => {
    const [cluster] = parkClusters(['k'], { column: 0, row: 3 }, []);
    expect(cluster!.labelAt).toEqual({ x: FIRST.x, y: FIRST.y + 3 * ROW_STEP });
  });
});

describe('arranging round an expanded lead', () => {
  // Expanded in place.
  const OPEN = { width: 960, height: 600 };
  const tiles: ArrangeTile[] = [
    agent('lead', { lead: true, size: OPEN }),
    { ...agent('shell'), kind: 'shell', state: null },
    agent('impl-a', { role: 'implementer', issue: 'ACME-9', createdAt: '1' }),
    agent('review-a', { role: 'reviewer', reviewOf: 'impl-a', createdAt: '2' }),
    agent('impl-b', { role: 'implementer', issue: 'ACME-12', createdAt: '3' }),
  ];

  it('in rows, puts the shells right of it and the lanes below it, their tiles beside their labels, not past its width', () => {
    const { positions, clusters } = arrangeTiles(tiles, [], { by: 'issue', layout: 'rows', width: 900, clusters: true });
    // The shell a tile gap past it, and the lanes a tile gap and a perch below it: not at the next grid column or row.
    expect(px(positions)).toEqual({ lead: [20, 44], shell: [996, 44], 'impl-a': [292, 684], 'review-a': [564, 684], 'impl-b': [292, 860] });
    expect(clusters.map((cluster) => cluster.labelAt)).toEqual([
      { x: 20, y: 684 },
      { x: 20, y: 860 },
    ]);
    expect(spread({ positions, clusters, size: { width: 0, height: 0 } }, tiles)).toEqual([]);
    expectClear(positions, tiles);
  });

  it('by role, starts every row below it at the first column', () => {
    const { positions } = arrangeTiles(tiles, [], { by: 'role', layout: 'rows', width: 900 });
    expect(px(positions)).toEqual({ lead: [20, 44], 'impl-a': [20, 684], 'impl-b': [292, 684], 'review-a': [20, 860], shell: [20, 1036] });
    expectClear(positions, tiles);
  });

  it('in cards, starts the cards below it at the first column', () => {
    const { positions, clusters } = arrangeTiles(tiles, [], { by: 'issue', layout: 'cards', width: 900, clusters: true });
    expect(px(positions)).toMatchObject({ lead: [20, 44], shell: [996, 44], 'impl-a': [292, 684], 'review-a': [564, 684] });
    expect(clusters[0]!.labelAt).toEqual({ x: 20, y: 684 });
    expectClear(positions, tiles);
  });
});

describe('arranging round an expanded crew member', () => {
  const OPEN = { width: 960, height: 600 };
  const tiles: ArrangeTile[] = [
    agent('lead', { lead: true }),
    agent('impl-a', { role: 'implementer', issue: 'ACME-9', createdAt: '1', size: OPEN }),
    agent('review-a', { role: 'reviewer', reviewOf: 'impl-a', createdAt: '2' }),
    agent('impl-b', { role: 'implementer', issue: 'ACME-12', createdAt: '3' }),
    agent('review-b', { role: 'reviewer', reviewOf: 'impl-b', createdAt: '4' }),
  ];

  it('in rows, widens only its own lane: the other lanes keep their tiles and note side by side', () => {
    const { positions, clusters } = arrangeTiles(tiles, [], { by: 'issue', layout: 'rows', width: 900, clusters: true });
    // Its lane's reviewer and note past it; the next lane's at the columns a compact lane takes.
    expect(px(positions)).toEqual({ lead: [20, 44], 'impl-a': [292, 220], 'review-a': [1268, 220], 'impl-b': [292, 860], 'review-b': [564, 860] });
    expect(clusters.map((cluster) => cluster.noteAt)).toEqual([
      { x: 1540, y: 220 },
      { x: 836, y: 860 },
    ]);
    expect(spread({ positions, clusters, size: { width: 0, height: 0 } }, tiles)).toEqual([]);
    expectClear(positions, tiles);
  });
});

describe('arranging by role or state round an expanded crew member', () => {
  const OPEN = { width: 960, height: 600 };
  const tiles: ArrangeTile[] = [
    agent('lead', { lead: true }),
    agent('impl-a', { role: 'implementer', issue: 'ACME-9', size: OPEN }),
    agent('review-a', { role: 'reviewer', reviewOf: 'impl-a' }),
    agent('impl-b', { role: 'implementer', issue: 'ACME-12' }),
    agent('review-b', { role: 'reviewer', reviewOf: 'impl-b' }),
  ];
  const links = [
    { from: 'impl-a', to: 'review-a' },
    { from: 'impl-b', to: 'review-b' },
  ];

  it('by role, keeps each reviewer under its implementer, its rail clear of the expanded tile', () => {
    const { positions } = arrangeTiles(tiles, links, { by: 'role', layout: 'rows', width: 900 });
    const at = cells(positions);
    expect(at['review-a']![0]).toBe(at['impl-a']![0]);
    expect(at['review-b']![0]).toBe(at['impl-b']![0]);
    expect(railTrouble(positions, tiles, links)).toEqual([]);
    expectClear(positions, tiles);
  });

  it('by state, lines its rows up whole round it, nothing on it', () => {
    const { positions } = arrangeTiles(tiles, links, { by: 'state', layout: 'rows', width: 900 });
    // Every tile idle: one row after the lead's, the expanded tile's column as wide as it, and a rail's room after each
    // tile its reviewer follows.
    expect(px(positions)).toEqual({ lead: [20, 44], 'impl-a': [20, 220], 'review-a': [1172, 220], 'impl-b': [1444, 220], 'review-b': [1892, 220] });
    expectClear(positions, tiles);
  });
});

describe('arranging cards round an expanded crew member', () => {
  const OPEN = { width: 960, height: 600 };
  const tiles: ArrangeTile[] = [
    agent('lead', { lead: true }),
    agent('impl-a', { role: 'implementer', issue: 'ACME-1', createdAt: '1', size: OPEN }),
    agent('review-a', { role: 'reviewer', reviewOf: 'impl-a', createdAt: '2' }),
    agent('impl-b', { role: 'implementer', issue: 'ACME-2', createdAt: '3' }),
    agent('review-b', { role: 'reviewer', reviewOf: 'impl-b', createdAt: '4' }),
    agent('impl-c', { role: 'implementer', issue: 'ACME-3', createdAt: '5' }),
    agent('review-c', { role: 'reviewer', reviewOf: 'impl-c', createdAt: '6' }),
  ];

  it('widens only its own line of cards: the card below keeps its tiles side by side', () => {
    const { positions } = arrangeTiles(tiles, [], { by: 'issue', layout: 'cards', width: 900, clusters: true });
    const at = px(positions);
    // Its own card's reviewer a tile gap past it; the card beside it past its card and a free column.
    expect(at['review-a']![0]).toBe(at['impl-a']![0] + OPEN.width + TILE_GAP);
    expect(at['impl-b']![0]).toBe(at['review-a']![0] + 2 * COLUMN + COLUMN);
    // The card below it, in the next line past a free row: its head, its implementer and its reviewer in the first three columns.
    expect([at['impl-c'], at['review-c']]).toEqual([
      [292, at['impl-a']![1] + OPEN.height + TILE_GAP + PERCH_ROOM + ROW_STEP],
      [564, at['impl-a']![1] + OPEN.height + TILE_GAP + PERCH_ROOM + ROW_STEP],
    ]);
    expectClear(positions, tiles);
  });
});

describe('arranging cards round an expanded tile in the top row, with no lead', () => {
  it('widens no card: the top row lines up with none', () => {
    const tiles: ArrangeTile[] = [
      { ...agent('shell'), kind: 'shell', state: null, size: { width: 960, height: 600 } },
      agent('impl-a', { role: 'implementer', issue: 'ACME-1', createdAt: '1' }),
      agent('review-a', { role: 'reviewer', reviewOf: 'impl-a', createdAt: '2' }),
    ];
    const { positions } = arrangeTiles(tiles, [], { by: 'issue', layout: 'cards', width: 900, clusters: true });
    expect(px(positions)).toEqual({ shell: [20, 44], 'impl-a': [292, 684], 'review-a': [564, 684] });
    expectClear(positions, tiles);
  });
});

/**
 * What is too far apart in an arrange in rows: across each line (the parts sharing a top), more than a tile gap between
 * neighbours, or a rail's room where `railed` says a rail runs between them; and down, more than a tile gap between a line's
 * lowest bottom and the next line's top (a rail's room more where one crosses).
 */
function spread(arranged: ReturnType<typeof arrangeTiles>, tiles: readonly ArrangeTile[], railed: (a: string, b: string) => boolean = () => false, railBetween: (above: number) => boolean = () => false): string[] {
  const parts = partsOf(arranged, tiles);
  // A line is the parts whose top (a tile's below its perch) is level.
  const top = (part: { id: string; rect: Rect }) => (arranged.positions.has(part.id) ? part.rect.y + PERCH_ROOM : part.rect.y);
  const lines = [...new Set(parts.map(top))].sort((a, b) => a - b).map((y) => parts.filter((part) => top(part) === y).sort((a, b) => a.rect.x - b.rect.x));
  const trouble: string[] = [];
  for (const line of lines) {
    for (const [index, part] of line.slice(1).entries()) {
      const before = line[index]!;
      const gap = part.rect.x - (before.rect.x + before.rect.width);
      if (gap > (railed(before.id, part.id) ? RAIL_GAP : TILE_GAP)) trouble.push(`${before.id} → ${part.id} ${gap} px apart`);
    }
  }
  for (const [index, line] of lines.slice(1).entries()) {
    const bottom = Math.max(...lines[index]!.map((part) => part.rect.y + part.rect.height));
    const gap = Math.min(...line.map((part) => part.rect.y)) - bottom;
    if (gap > (railBetween(index + 1) ? RAIL_GAP : TILE_GAP)) trouble.push(`line ${index + 1} ${gap} px below line ${index}`);
  }
  return trouble;
}

describe('arranging in pixels', () => {
  const lanes: ArrangeTile[] = [
    agent('lead', { lead: true }),
    { ...agent('gate'), kind: 'shell', state: null },
    agent('impl-a', { role: 'implementer', issue: 'ACME-9', createdAt: '1' }),
    agent('review-a', { role: 'reviewer', reviewOf: 'impl-a', createdAt: '2' }),
    agent('impl-b', { role: 'implementer', issue: 'ACME-12', createdAt: '3' }),
    agent('review-b', { role: 'reviewer', reviewOf: 'impl-b', createdAt: '4' }),
  ];
  const arranged = (tiles: readonly ArrangeTile[], options: Partial<Parameters<typeof arrangeTiles>[2]> = {}, links: { from: string; to: string }[] = []) =>
    arrangeTiles(tiles, links, { by: 'issue', layout: 'rows', width: 600, clusters: true, ...options });

  it('makes a lane with a 140 px note only as tall as its note, the next lane a tile gap below it', () => {
    const result = arranged(lanes, { noteHeights: new Map([['issue:ACME-9', 140]]) });
    const a = result.clusters[0]!;
    expect(a.noteSize.height).toBe(140);
    expect(result.positions.get('impl-b')!.y - PERCH_ROOM).toBe(a.noteAt.y + 140 + TILE_GAP);
    expect(spread(result, lanes)).toEqual([]);
  });

  it('spreads only its own lane round one expanded reviewer: its note a tile gap past it, the next lane a tile gap below it', () => {
    const OPEN = { width: 960, height: 600 };
    const tiles = lanes.map((tile) => (tile.id === 'review-a' ? { ...tile, size: OPEN } : tile));
    const result = arranged(tiles);
    const [a, b] = result.clusters;
    const reviewA = result.positions.get('review-a')!;
    expect(a!.noteAt.x).toBe(reviewA.x + OPEN.width + TILE_GAP);
    // The next lane's reviewer and note where a compact lane's go.
    expect(result.positions.get('review-b')!.x).toBe(reviewA.x);
    expect(b!.noteAt.x).toBe(reviewA.x + COLUMN);
    expect(result.positions.get('impl-b')!.y).toBe(reviewA.y + OPEN.height + TILE_GAP + PERCH_ROOM);
    expect(spread(result, tiles)).toEqual([]);
    expectClear(result.positions, tiles);
  });

  it('leaves joined pairs exactly a rail’s room apart, and a lane joined to the lead a rail’s room below it, over its characters', () => {
    const links = [
      { from: 'lead', to: 'impl-a' },
      ...['a', 'b'].flatMap((lane) => [
        { from: `impl-${lane}`, to: `review-${lane}` },
        { from: `review-${lane}`, to: `impl-${lane}` },
      ]),
    ];
    const result = arranged(lanes, {}, links);
    const joined = (x: string, y: string) => links.some((link) => link.from === x && link.to === y);
    expect(spread(result, lanes, joined, (line) => line === 1)).toEqual([]);
    expect(railTrouble(result.positions, lanes, links)).toEqual([]);
    for (const lane of ['a', 'b']) expect(result.positions.get(`review-${lane}`)!.x - (result.positions.get(`impl-${lane}`)!.x + AGENT_TILE_SIZE.width)).toBe(RAIL_GAP);
    expect(result.positions.get('impl-a')!.y - PERCH_ROOM - (result.positions.get('lead')!.y + AGENT_TILE_SIZE.height)).toBe(RAIL_GAP);
  });

  it('as columns, puts the column after an expanded tile a tile gap past it, not at the next grid column', () => {
    const OPEN = { width: 960, height: 600 };
    const tiles = lanes.map((tile) => (tile.id === 'impl-a' ? { ...tile, size: OPEN } : tile));
    const result = arrangeTiles(tiles, [], { by: 'issue', layout: 'columns', width: 600, clusters: true });
    const implA = result.positions.get('impl-a')!;
    expect(result.positions.get('impl-b')!.x).toBe(implA.x + OPEN.width + TILE_GAP);
    // Under it, its reviewer a tile gap and a perch below it.
    expect(result.positions.get('review-a')!.y).toBe(implA.y + OPEN.height + TILE_GAP + PERCH_ROOM);
    expect(offGrid(result, tiles)).toEqual([]);
    expectClear(result.positions, tiles);
  });
});
