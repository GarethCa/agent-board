import { describe, expect, it } from 'vitest';
import { agentNoteSize } from '../src/agent-notes.ts';
import { arrangeTiles, CLUSTER_LABEL_SIZE, lanesOf, type ArrangeTile } from '../src/board-arrange.ts';
import { AGENT_TILE_SIZE, GRID_COLUMN, ROW_STEP } from '../src/board-layout.ts';
import { DEFAULT_ARRANGE_SETTINGS, type ArrangeBy, type ArrangeLayout, type ZoneMap, type ZoneMapThing } from '../src/protocol.ts';
import { boxPicture, buildZoneMap, laneTable, spareSlots } from '../src/zone-map.ts';

function agent(id: string, fields: Partial<ArrangeTile> = {}): ArrangeTile {
  return { id: `agent:${id}`, name: id, kind: 'agent', role: null, issue: null, state: 'idle', reviewOf: null, lead: false, ...fields };
}

const crew: ArrangeTile[] = [
  agent('lead', { lead: true, state: 'running' }),
  { ...agent('gate', { state: null }), id: 'shell:gate', kind: 'shell' },
  agent('impl-a', { role: 'implementer', issue: 'ACME-9', state: 'needs-permission' }),
  agent('review-a', { role: 'reviewer', reviewOf: 'agent:impl-a', state: 'running' }),
  agent('impl-b', { role: 'implementer', issue: 'ACME-12', state: 'done' }),
];

/** A zone of `tiles` as an arrange left it: each tile where it went, each lane's label and note. */
function arrangedZone(
  tiles: readonly ArrangeTile[],
  move: (thing: ZoneMapThing) => ZoneMapThing = (thing) => thing,
  layout: ArrangeLayout = 'rows',
  links: readonly { from: string; to: string }[] = [],
  noteHeights?: ReadonlyMap<string, number>,
  by: ArrangeBy = 'issue',
): ZoneMap {
  const { positions, clusters, size } = arrangeTiles(tiles, links, { by, layout, width: 600, clusters: true, noteHeights });
  const things: ZoneMapThing[] = [
    ...tiles.map((tile) => ({ key: tile.id, itemKind: null, name: tile.name, state: tile.state, ...positions.get(tile.id)!, ...(tile.size ?? AGENT_TILE_SIZE) })),
    ...clusters.flatMap((cluster) => [
      { key: `item:${cluster.key}-label`, itemKind: 'text', name: cluster.label, state: null, ...cluster.labelAt, ...CLUSTER_LABEL_SIZE },
      { key: `item:${cluster.key}-note`, itemKind: 'agent-note', name: 'note', state: null, ...cluster.noteAt, ...cluster.noteSize },
    ]),
  ].map(move);
  const parts = new Map(clusters.flatMap((cluster) => [[`${cluster.key}#label`, `item:${cluster.key}-label`] as const, [`${cluster.key}#note`, `item:${cluster.key}-note`] as const]));
  const arrange = { ...DEFAULT_ARRANGE_SETTINGS, by, layout };
  return { zoneId: 'z', name: 'web', ...size, arrange, things, ...buildZoneMap({ lanes: lanesOf(tiles, links), things, parts, arrange, arranged: positions }) };
}

/** A ref as the CLI writes one: its kind and the start of its id. */
const ref = (key: string) => key.replace(/^(\w+):(.{0,10}).*$/, '$1:$2');

const MAX_SPARE = 2;

describe('a zone map', () => {
  it('after an arrange, has a lane per issue, its tiles by slot and its note, and nothing amiss', () => {
    const map = arrangedZone(crew);
    expect(map.top).toEqual(['agent:lead', 'shell:gate']);
    expect(map.lanes.map(({ key, slots, note }) => ({ key, slots, note }))).toEqual([
      { key: 'issue:ACME-9', slots: { implementer: ['agent:impl-a'], reviewer: ['agent:review-a'], 'follow-up': [] }, note: 'item:issue:ACME-9-note' },
      { key: 'issue:ACME-12', slots: { implementer: ['agent:impl-b'], reviewer: [], 'follow-up': [] }, note: 'item:issue:ACME-12-note' },
    ]);
    expect(map.overlaps).toEqual([]);
    expect(map.offGrid).toEqual([]);
    // Each lane's note right after its last tile: no gap wider than a tile's.
    expect(map.widestGap).toBe(0);
  });

  it('puts what is in no lane (the user’s notes) on the top row', () => {
    const map = arrangedZone(crew);
    const sticky: ZoneMapThing = { key: 'item:mine', itemKind: 'sticky', name: 'mine', state: null, x: 900, y: 20, width: 200, height: 136 };
    const things = [...map.things, sticky];
    const parts = new Map(map.lanes.flatMap((lane) => [[`${lane.key}#label`, lane.labelItem!] as const, [`${lane.key}#note`, lane.note!] as const]));
    expect(buildZoneMap({ lanes: lanesOf(crew, []), things, parts, arrange: DEFAULT_ARRANGE_SETTINGS }).top).toEqual(['agent:lead', 'shell:gate', 'item:mine']);
  });

  it('finds tiles on top of each other, and a tile dragged out of its lane’s row or off the grid', () => {
    const map = arrangedZone(crew, (thing) => {
      if (thing.key === 'agent:review-a') return { ...thing, x: thing.x + 10 };
      if (thing.key === 'agent:impl-b') return { ...thing, y: thing.y + 40 };
      return thing;
    });
    expect(map.offGrid.toSorted()).toEqual(['agent:impl-b', 'agent:review-a']);
    expect(map.overlaps).toEqual([]);
    const piled = arrangedZone(crew, (thing) => (thing.key === 'shell:gate' ? { ...thing, x: 30, y: 50 } : thing));
    expect(piled.overlaps).toEqual([['agent:lead', 'shell:gate']]);
  });

  it('finds a tile nudged down off its row in every layout and grouping, the lead and shells too', () => {
    const tiles = [...crew, agent('review-b', { role: 'reviewer', reviewOf: 'agent:impl-b', createdAt: '9' })];
    for (const by of ['issue', 'role', 'state'] as const) {
      for (const layout of ['rows', 'columns', 'cards'] as const) {
        expect(arrangedZone(tiles, undefined, layout, [], undefined, by).offGrid, `${by} ${layout}`).toEqual([]);
        for (const key of ['agent:lead', 'shell:gate', 'agent:review-a']) {
          const nudged = arrangedZone(tiles, (thing) => (thing.key === key ? { ...thing, y: thing.y + 30 } : thing), layout, [], undefined, by);
          expect(nudged.offGrid, `${key} ${by} ${layout}`).toContain(key);
        }
      }
    }
  });

  it('names only the tile dragged off its place, never a neighbour packed past it that stayed put', () => {
    // By role in columns, the shell's column is packed a tile gap past the reviewers': off the grid, where an arrange puts it.
    const links = [{ from: 'agent:impl-a', to: 'agent:review-a' }];
    const fresh = arrangedZone(crew, undefined, 'columns', links, undefined, 'role');
    expect(fresh.offGrid).toEqual([]);
    const dragged = arrangedZone(crew, (thing) => (thing.key === 'agent:review-a' ? { ...thing, x: thing.x + 30 } : thing), 'columns', links, undefined, 'role');
    expect(dragged.offGrid).toEqual(['agent:review-a']);
  });

  it('holds a tile no arrange placed to the grid: on a cell it is fine, off one it is not', () => {
    const tile = (key: string, x: number, y: number): ZoneMapThing => ({ key, itemKind: null, name: key, state: 'idle', x, y, ...AGENT_TILE_SIZE });
    const lanes = { top: [agent('lead', { lead: true }), agent('loose')], lanes: [] };
    const things = [tile('agent:lead', 20, 44), tile('agent:loose', 292 + 5, 44)];
    expect(buildZoneMap({ lanes, things, parts: new Map(), arrange: DEFAULT_ARRANGE_SETTINGS }).offGrid).toEqual(['agent:loose']);
  });

  it('counts no overlap a tile expanded in place makes over what it was clear of compact, which the board pushes aside', () => {
    const tile = (key: string, x: number, y: number, size = AGENT_TILE_SIZE): ZoneMapThing => ({ key, itemKind: null, name: key, state: 'idle', x, y, ...size });
    const open = tile('agent:open', 20, 44, { width: 960, height: 600 });
    const things = [open, tile('agent:beside', 292, 44), tile('agent:under', 20, 220), tile('agent:piled', 30, 50)];
    const map = buildZoneMap({
      lanes: { top: [], lanes: [] },
      things,
      parts: new Map(),
      arrange: DEFAULT_ARRANGE_SETTINGS,
      compact: new Map([['agent:open', { x: 20, y: 44, ...AGENT_TILE_SIZE }]]),
    });
    // One on top of it compact still overlaps it.
    expect(map.overlaps).toEqual([['agent:open', 'agent:piled']]);
    expect(buildZoneMap({ lanes: { top: [], lanes: [] }, things, parts: new Map(), arrange: DEFAULT_ARRANGE_SETTINGS }).overlaps).toHaveLength(3);
  });

  it('reads a lane laid out as a column along its column, and one laid out as cards only for the grid', () => {
    const columns = arrangedZone(crew, undefined, 'columns');
    expect([columns.overlaps, columns.offGrid, columns.widestGap]).toEqual([[], [], 0]);
    const nudged = arrangedZone(crew, (thing) => (thing.key === 'agent:review-a' ? { ...thing, x: thing.x + GRID_COLUMN } : thing), 'columns');
    expect(nudged.offGrid).toEqual(['agent:review-a']);
    const cards = arrangedZone(crew, undefined, 'cards');
    expect([cards.overlaps, cards.offGrid]).toEqual([[], []]);
  });

  it('lints a fresh arrange of lanes that differ ok, in every layout: one with a follow-up, one with an implementer alone', () => {
    const mixed: ArrangeTile[] = [
      agent('lead', { lead: true }),
      agent('impl-a', { role: 'implementer', issue: 'ACME-10' }),
      agent('review-a', { role: 'reviewer', reviewOf: 'agent:impl-a' }),
      agent('again-a', { role: 'follow-up-reviewer', reviewOf: 'agent:impl-a' }),
      agent('impl-b', { role: 'implementer', issue: 'ACME-11' }),
      agent('impl-c', { role: 'implementer', issue: 'ACME-12' }),
      agent('review-c', { role: 'reviewer', reviewOf: 'agent:impl-c' }),
    ];
    const links = [
      { from: 'agent:impl-a', to: 'agent:review-a' },
      { from: 'agent:review-a', to: 'agent:impl-a' },
      { from: 'agent:impl-c', to: 'agent:review-c' },
      { from: 'agent:review-c', to: 'agent:impl-c' },
    ];
    for (const layout of ['rows', 'columns', 'cards'] as const) {
      const map = arrangedZone(mixed, undefined, layout, links);
      expect(laneTable(map, 'zone:z', ref).split('\n').at(-1), layout).toMatch(/^lint {2}ok · /);
      expect(laneTable(map, 'zone:z', ref), layout).toContain(`next lane → ${{ rows: 'row', columns: 'column', cards: 'card' }[layout]} 4`);
    }
  });

  it('lints an arrange round an expanded lead, an expanded reviewer, a short note and joined pairs ok, in every layout', () => {
    const OPEN = { width: 960, height: 600 };
    const tiles: ArrangeTile[] = [
      agent('lead', { lead: true, size: OPEN }),
      agent('impl-a', { role: 'implementer', issue: 'ACME-10', createdAt: '1' }),
      agent('review-a', { role: 'reviewer', reviewOf: 'agent:impl-a', createdAt: '2', size: OPEN }),
      agent('impl-b', { role: 'implementer', issue: 'ACME-11', createdAt: '3' }),
      agent('review-b', { role: 'reviewer', reviewOf: 'agent:impl-b', createdAt: '4' }),
    ];
    const links = ['a', 'b'].flatMap((lane) => [
      { from: `agent:impl-${lane}`, to: `agent:review-${lane}` },
      { from: `agent:review-${lane}`, to: `agent:impl-${lane}` },
    ]);
    for (const layout of ['rows', 'columns', 'cards'] as const) {
      const map = arrangedZone(tiles, undefined, layout, links, new Map([['issue:ACME-11', 140]]));
      expect(laneTable(map, 'zone:z', ref).split('\n').at(-1), layout).toMatch(/^lint {2}ok · /);
    }
  });

  it('lints an arrange of lanes with notes of ten lines and more ok, in every layout: each lane makes room for its note', () => {
    const tall = new Map([
      ['issue:ACME-9', agentNoteSize(Array.from({ length: 10 }, (_, index) => `- step ${index + 1}`).join('\n'), 256, 0).height],
      ['issue:ACME-12', 400],
    ]);
    for (const layout of ['rows', 'columns', 'cards'] as const) {
      const map = arrangedZone(crew, undefined, layout, [], tall);
      expect(map.things.find((thing) => thing.key === 'item:issue:ACME-12-note')!.height, layout).toBe(400);
      expect(laneTable(map, 'zone:z', ref).split('\n').at(-1), layout).toMatch(/^lint {2}ok · /);
    }
  });

  it('counts the widest gap in a lane in slots', () => {
    const far = arrangedZone(crew, (thing) => (thing.key === 'item:issue:ACME-12-note' ? { ...thing, x: thing.x + 3 * GRID_COLUMN } : thing));
    expect(far.widestGap).toBe(3);
  });

  it('counts the space between a lane and the next across, in slots', () => {
    const lastLane = (thing: ZoneMapThing) => thing.key.includes('ACME-12') || thing.key === 'agent:impl-b';
    const rows = arrangedZone(crew);
    expect([rows.laneGap, rows.labelGap]).toEqual([0, 0]);
    const apartRows = arrangedZone(crew, (thing) => (lastLane(thing) ? { ...thing, y: thing.y + 3 * ROW_STEP } : thing));
    expect(apartRows.laneGap).toBe(3);
    const apartColumns = arrangedZone(crew, (thing) => (lastLane(thing) ? { ...thing, x: thing.x + 3 * GRID_COLUMN } : thing), 'columns');
    expect(apartColumns.laneGap).toBe(3);
    // A layout of cards has no lanes in a line to measure.
    expect(arrangedZone(crew, (thing) => (lastLane(thing) ? { ...thing, y: thing.y + 3 * ROW_STEP } : thing), 'cards').laneGap).toBe(0);
  });

  const isLaneThing = (thing: ZoneMapThing) => !['agent:lead', 'shell:gate'].includes(thing.key);
  /** A zone with every lane five rows lower, grown to match as the board does. */
  const lanesDown = (layout: ArrangeLayout) => {
    const map = arrangedZone(crew, (thing) => (isLaneThing(thing) ? { ...thing, y: thing.y + 5 * ROW_STEP } : thing), layout);
    return { ...map, height: map.height + 5 * ROW_STEP };
  };

  it('counts the space from the top row to the first lane, in rows and in columns', () => {
    for (const layout of ['rows', 'columns'] as const) {
      expect(lanesDown(layout).laneGap, layout).toBe(5);
      expect(laneTable(lanesDown(layout), 'zone:z', ref).split('\n').at(-1), layout).toBe(
        'lint  check · no overlaps · widest gap 0 slots · 0 off-grid · 5 slots between lanes',
      );
      expect(arrangedZone(crew, undefined, layout).laneGap, layout).toBe(0);
    }
    // The user's loose items are no top row: a sticky far above the lanes changes nothing.
    const map = arrangedZone(crew);
    const sticky: ZoneMapThing = { key: 'item:mine', itemKind: 'sticky', name: 'mine', state: null, x: 900, y: 20, width: 200, height: 136 };
    const parts = new Map(map.lanes.flatMap((lane) => [[`${lane.key}#label`, lane.labelItem!] as const, [`${lane.key}#note`, lane.note!] as const]));
    expect(buildZoneMap({ lanes: lanesOf(crew, []), things: [...map.things, sticky], parts, arrange: DEFAULT_ARRANGE_SETTINGS }).laneGap).toBe(0);
  });

  it('counts how far a lane’s label lies from its lane, in slots, the way the widest gap counts it', () => {
    const label = (thing: ZoneMapThing) => thing.key === 'item:issue:ACME-9-label';
    const inRows = arrangedZone(crew, (thing) => (label(thing) ? { ...thing, x: thing.x - 4 * GRID_COLUMN } : thing));
    expect([inRows.labelGap, inRows.widestGap]).toEqual([4, 4]);
    const inColumns = arrangedZone(crew, (thing) => (label(thing) ? { ...thing, y: thing.y - 3 * ROW_STEP } : thing), 'columns');
    expect([inColumns.labelGap, inColumns.widestGap]).toEqual([2, 2]);
    // Dragged to the far end of its lane, nothing lies between it and its neighbours: only the label gap says so.
    const past = arrangedZone(crew, (thing) => (label(thing) ? { ...thing, x: thing.x + 5 * GRID_COLUMN } : thing));
    expect(past.labelGap).toBeGreaterThan(past.widestGap);
    // A fresh arrange of a column with no note has no label gap.
    const noNote = arrangedZone(crew, undefined, 'columns');
    expect([noNote.labelGap, noNote.widestGap]).toEqual([0, 0]);
  });

  it('says on the lint line when lanes lie far apart, a label is far from its lane, or the zone is far bigger than its contents', () => {
    const last = (map: ZoneMap) => laneTable(map, 'zone:z', ref).split('\n').at(-1);
    const apart = arrangedZone(crew, (thing) => (thing.key.includes('ACME-12') || thing.key === 'agent:impl-b' ? { ...thing, y: thing.y + 4 * ROW_STEP } : thing));
    expect(last(apart)).toBe('lint  check · no overlaps · widest gap 0 slots · 0 off-grid · 4 slots between lanes');
    // Beside a gap the widest gap already names, the label's is not said again.
    const stray = arrangedZone(crew, (thing) => (thing.key === 'item:issue:ACME-9-label' ? { ...thing, x: thing.x - 4 * GRID_COLUMN } : thing));
    expect(last(stray)).toBe('lint  check · no overlaps · widest gap 4 slots · 0 off-grid');
    const past = arrangedZone(crew, (thing) => (thing.key === 'item:issue:ACME-9-label' ? { ...thing, x: thing.x + 5 * GRID_COLUMN } : thing));
    expect(last(past)).toMatch(/^lint {2}check · .* · label \d slots from its tiles$/);
    const roomy = { ...arrangedZone(crew), width: 4000, height: 3000 };
    expect(last(roomy)).toMatch(/^lint {2}check · .* · zone \d+ columns and \d+ rows bigger than its contents$/);
    expect(last(arrangedZone(crew))).toMatch(/^lint {2}ok · /);
  });

  it('measures a zone against what an arrange fits it to, not by the padding round its contents', () => {
    const lead: ZoneMapThing = { key: 'agent:lead', itemKind: null, name: 'lead', state: 'idle', x: 20, y: 44, ...AGENT_TILE_SIZE };
    // The default zone with only its orchestrator in it is a little over the least size a zone fits to: no flag.
    expect(spareSlots({ width: 720, height: 480, things: [lead] })).toEqual({ columns: 2, rows: 2 });
    expect(spareSlots({ width: 4000, height: 3000, things: [lead] }).columns).toBeGreaterThan(MAX_SPARE);
    expect(spareSlots({ width: 100, height: 100, things: [] })).toEqual({ columns: 0, rows: 0 });
    const fresh = { ...arrangedZone([agent('lead', { lead: true })]), width: 720, height: 480 };
    expect(laneTable(fresh, 'zone:z', ref).split('\n').at(-1)).toMatch(/^lint {2}ok · /);
    const alone = { ...arrangedZone([agent('lead', { lead: true })]) };
    expect(laneTable(alone, 'zone:z', ref).split('\n').at(-1)).toMatch(/^lint {2}ok · /);
  });

  it('reads as a lane table: a line per lane, a cell per slot, then where the next lane goes and the lint', () => {
    expect(laneTable(arrangedZone(crew), 'zone:z', ref)).toBe(
      [
        'zone zone:z web · 1112×568 · by issue, in rows · auto-arrange off',
        '',
        'lane    │ implementer                          │ reviewer                        │ follow-up │ notes',
        '────────┼──────────────────────────────────────┼─────────────────────────────────┼───────────┼────────────────',
        'top     │ agent:lead lead running              │ shell:gate gate shell           │           │',
        'ACME-9  │ agent:impl-a impl-a needs-permission │ agent:review-a review-a running │ ·         │ item:issue:ACME',
        'ACME-12 │ agent:impl-b impl-b done             │ ·                               │ ·         │ item:issue:ACME',
        '',
        'free  next lane → row 3 · ACME-12 can fold (all done)',
        'lint  ok · no overlaps · widest gap 0 slots · 0 off-grid',
      ].join('\n'),
    );
  });

  it('says what is amiss on its lint line', () => {
    const piled = arrangedZone(crew, (thing) => (thing.key === 'shell:gate' ? { ...thing, x: 30, y: 50 } : thing));
    expect(laneTable(piled, 'zone:z', ref).split('\n').at(-1)).toBe('lint  check · 1 overlapping (agent:lead / shell:gate) · widest gap 0 slots · 1 off-grid (shell:gate)');
  });

  it('draws as a box picture, marking an overlap with #, with a legend of its keys', () => {
    const picture = boxPicture(arrangedZone(crew), 'zone:z', ref);
    const lines = picture.split('\n');
    expect(lines[2]).toMatch(/^┌─ web ─+┐$/);
    expect(picture).toContain('[a w');
    expect(picture).toContain('│  ACME [c !  ][d w  ]<f   > │');
    expect(picture).toContain('a agent:lead lead (running)');
    expect(picture).not.toContain('#');
    const piled = boxPicture(
      arrangedZone(crew, (thing) => (thing.key === 'shell:gate' ? { ...thing, x: 30, y: 50 } : thing)),
      'zone:z',
      ref,
    );
    expect(piled).toContain('#');
    // Every row of the frame is as wide as its top.
    const frame = lines.filter((line) => /^[┌│└]/.test(line));
    expect(new Set(frame.map((line) => [...line].length)).size).toBe(1);
  });
});
