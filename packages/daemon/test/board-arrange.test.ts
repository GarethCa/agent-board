import { describe, expect, it } from 'vitest';
import { arrangeTiles, CLUSTER_LABEL_SIZE, CLUSTER_NOTE_SIZE, parkClusters, ticketOfBranch, type ArrangeTile } from '../src/board-arrange.ts';
import { AGENT_TILE_SIZE, clearOf, PERCH_ROOM, RAIL_GAP, ROW_STEP, sizedFootprint, TILE_GAP, ZONE_PADDING, type Point, type Rect } from '../src/board-layout.ts';

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

/** Whether `point` is on the zone's grid: a whole number of columns and rows from its first slot. */
const onGrid = ({ x, y }: Point) => Number.isInteger((x - FIRST.x) / COLUMN) && Number.isInteger((y - FIRST.y) / ROW_STEP);

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
    // The rail between impl-b and review-b takes a column, in every row; the lead's into impl-a a row.
    expect(cells(positions)).toEqual({
      lead: [0, 0],
      notes: [2, 0],
      'impl-a': [0, 2],
      'review-a': [2, 2],
      'impl-b': [0, 3],
      'review-b': [2, 3],
      loner: [0, 4],
    });
  });

  it("leaves a rail's room between tiles an edge joins, on the grid and in every row, and none where no edge does", () => {
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
    const { positions } = arrangeTiles(tiles, handBack, { by: 'issue', layout: 'rows', width: 900, clusters: true });
    const [implA, reviewA, implB, reviewB] = ['impl-a', 'review-a', 'impl-b', 'review-b'].map((id) => positions.get(id)!);
    expect(reviewA!.x - (implA!.x + AGENT_TILE_SIZE.width)).toBeGreaterThanOrEqual(RAIL_GAP);
    expect([...positions.values()].every(onGrid)).toBe(true);
    // The other cluster's reviewer keeps the column, so reviewers still line up.
    expect(reviewB!.x).toBe(reviewA!.x);
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
    const { positions } = arrangeTiles(tiles, both, { by: 'issue', layout: 'rows', width: 900, clusters: true });
    const [impl, review, again] = ['impl', 'review', 'again'].map((id) => positions.get(id)!);
    expect(review!.y).toBe(again!.y);
    // Whichever end the far rail's token is at, it lies in a rail's room: after impl, or before again.
    expect(review!.x - (impl!.x + AGENT_TILE_SIZE.width)).toBeGreaterThanOrEqual(RAIL_GAP);
    expect(again!.x - (review!.x + AGENT_TILE_SIZE.width)).toBeGreaterThanOrEqual(RAIL_GAP);
    expect([...positions.values()].every(onGrid)).toBe(true);
  });

  it("as a grid, leaves a rail's room between tiles an edge joins, as rows do, its line crossing no tile", () => {
    const tiles = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => agent(id, { createdAt: id }));
    const joined = [
      { from: 'a', to: 'c' },
      { from: 'b', to: 'e' },
    ];
    const { positions } = arrangeTiles(tiles, joined, { by: 'state', layout: 'grid', width: 2 * ZONE_PADDING + 4 * COLUMN - TILE_GAP });
    expect(railTrouble(positions, tiles, joined)).toEqual([]);
    expect([...positions.values()].every(onGrid)).toBe(true);
    expectClear(positions, tiles);
  });

  /** Asserts the tiles of `block` are where rows put them, laid out alone, and that the others keep off them and their rails. */
  function expectRowsBlock(tiles: readonly ArrangeTile[], joined: readonly { from: string; to: string }[], block: readonly string[], width: number) {
    const { positions } = arrangeTiles(tiles, joined, { by: 'issue', layout: 'grid', width });
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
    expect([...positions.values()].every(onGrid)).toBe(true);
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
    expect(review.y - (impl.y + AGENT_TILE_SIZE.height)).toBeGreaterThanOrEqual(RAIL_GAP);
    expect(onGrid(review)).toBe(true);
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
    expect(cells(positions)).toEqual({
      lead: [0, 0],
      'impl-a': [0, 2],
      'impl-b': [1, 2],
      loner: [2, 4],
      'review-a': [0, 6],
      'review-b': [1, 6],
      notes: [0, 7],
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
    expect(cells(positions)).toEqual({
      lead: [0, 0],
      'impl-a': [0, 2],
      'review-a': [2, 2],
      'impl-b': [0, 3],
      'review-b': [2, 3],
      notes: [1, 0],
      loner: [2, 0],
    });
    expect(railTrouble(positions, crew, edges)).toEqual([]);
  });

  it('keeps a row clear of what it may not move, moving the whole row down past it, onto the grid', () => {
    // Where review-a would go, past the rails' column and row.
    const note: Rect = { x: FIRST.x + 2 * COLUMN, y: FIRST.y + 2 * ROW_STEP, width: 200, height: 200 };
    const { positions } = arrangeTiles(crew, edges, { by: 'issue', layout: 'rows', width: 900, obstacles: [note] });
    expectClear(positions, crew, [note]);
    expect(positions.get('impl-a')!.y).toBe(positions.get('review-a')!.y);
    expect(positions.get('impl-a')!.y).toBeGreaterThan(note.y + note.height);
    expect([...positions.values()].every(onGrid)).toBe(true);
  });

  it('lays resized tiles out at their size, over as many grid columns as they need, and says how big the zone must be', () => {
    const big = agent('impl-a', { role: 'implementer', issue: 'ACME-9', size: { width: 480, height: 300 } });
    const tiles = [...crew.filter((tile) => tile.id !== 'impl-a'), big];
    const { positions, size } = arrangeTiles(tiles, edges, { by: 'issue', layout: 'rows', width: 300 });
    expectClear(positions, tiles);
    expect([...positions.values()].every(onGrid)).toBe(true);
    // Its column is two wide in every row, so the reviewers still line up.
    expect(positions.get('review-a')!.x).toBe(FIRST.x + 2 * COLUMN);
    expect(positions.get('review-b')!.x).toBe(FIRST.x + 2 * COLUMN);
    const right = Math.max(...tiles.map((tile) => positions.get(tile.id)!.x + (tile.size ?? AGENT_TILE_SIZE).width));
    const bottom = Math.max(...tiles.map((tile) => positions.get(tile.id)!.y + (tile.size ?? AGENT_TILE_SIZE).height));
    expect(size.width).toBe(right + ZONE_PADDING);
    expect(size.height).toBe(bottom + TILE_GAP + ZONE_PADDING);
  });

  it('places nothing for no tiles', () => {
    expect(arrangeTiles([], [], { by: 'issue', layout: 'rows', width: 600 }).positions.size).toBe(0);
  });

  it('puts every tile on the grid, whatever it is arranged by and however laid out', () => {
    const note: Rect = { x: 333, y: 91, width: 157, height: 211 };
    const big = agent('big', { size: { width: 301, height: 180 } });
    for (const by of ['issue', 'role', 'state'] as const) {
      for (const layout of ['rows', 'columns', 'cards', 'grid'] as const) {
        const tiles = [...crew, big];
        const { positions, clusters } = arrangeTiles(tiles, edges, { by, layout, width: 1000, obstacles: [note], clusters: true });
        expect([...positions.values()].filter((point) => !onGrid(point))).toEqual([]);
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
  // Joined by an edge, the second is a rail's column (an empty grid column) to the right of the first.
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
    expect(cells(positions)).toEqual({ impl: [0, 0], review: [2, 0] });
  });

  it('follows what a reviewer reviews over any edge back to it', () => {
    const tiles = [agent('impl', { role: 'custom' }), agent('review', { role: 'custom', reviewOf: 'impl' })];
    const { positions } = arrangeTiles(tiles, [{ from: 'review', to: 'impl' }], { by: 'issue', layout: 'rows', width: 900 });
    expect(cells(positions)).toEqual({ impl: [0, 0], review: [2, 0] });
  });

  it('with edges both ways and no reviewer, puts an implementer first, else the one started first', () => {
    const byRole = [agent('b', { role: 'implementer', createdAt: '2' }), agent('a', { role: 'custom', createdAt: '1' })];
    expect(cells(arrangeTiles(byRole, both('a', 'b'), { by: 'issue', layout: 'rows', width: 900 }).positions)).toEqual({ b: [0, 0], a: [2, 0] });
    const bySpawn = [agent('a', { role: 'custom', createdAt: '2' }), agent('b', { role: 'custom', createdAt: '1' })];
    expect(cells(arrangeTiles(bySpawn, both('a', 'b'), { by: 'issue', layout: 'rows', width: 900 }).positions)).toEqual({ b: [0, 0], a: [2, 0] });
  });
});

describe('arranging a crowded zone', () => {
  it('lays rows out below what fills the zone, and returns', () => {
    const wall: Rect = { x: 0, y: 0, width: 5000, height: 3000 };
    const many = Array.from({ length: 40 }, (_, index) => agent(`a${index}`));
    for (const layout of ['rows', 'grid'] as const) {
      const { positions } = arrangeTiles(many, [], { by: 'issue', layout, width: 600, obstacles: [wall] });
      expect(positions.size).toBe(40);
      expectClear(positions, many, [wall]);
      expect([...positions.values()].every(onGrid)).toBe(true);
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

  it('gives a lane with a tall note as many grid rows as its note takes, the next lane below it', () => {
    const { positions, clusters } = arranged(lanes, { noteHeights: new Map([['issue:ACME-9', 300]]) });
    const a = clusters.find((cluster) => cluster.key === 'issue:ACME-9')!;
    expect(a.noteSize).toEqual({ width: CLUSTER_NOTE_SIZE.width, height: 300 });
    // 300 px takes two grid rows: the next lane starts on the third.
    expect(cells(positions)['impl-b']![1] - cells(positions)['impl-a']![1]).toBe(2);
    expect(positions.get('impl-b')!.y - PERCH_ROOM).toBeGreaterThanOrEqual(a.noteAt.y + 300 + TILE_GAP);
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

  it('measures a resized or expanded tile at its size: its lane is taller and its column wider', () => {
    const big = { width: 2 * COLUMN + AGENT_TILE_SIZE.width, height: 2 * ROW_STEP + AGENT_TILE_SIZE.height };
    const tiles = lanes.map((tile) => (tile.id === 'impl-a' ? { ...tile, size: big } : tile));
    const { positions, clusters } = arranged(tiles);
    const at = cells(positions);
    expect(at['review-a']![0]).toBe(4);
    expect(at['impl-b']![0]).toBe(1);
    expect(at['impl-b']![1]).toBe(4);
    expect(column(clusters[1]!.noteAt)).toBe(4);
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
    expect(cells(positions)['review-a']![1] - cells(positions)['impl-a']![1]).toBe(2);
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
      expect(onGrid(cluster.labelAt)).toBe(true);
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
