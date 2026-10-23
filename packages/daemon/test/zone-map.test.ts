import { describe, expect, it } from 'vitest';
import { agentNoteSize } from '../src/agent-notes.ts';
import { arrangeTiles, CLUSTER_LABEL_SIZE, lanesOf, type ArrangeTile } from '../src/board-arrange.ts';
import { AGENT_TILE_SIZE, GRID_COLUMN } from '../src/board-layout.ts';
import { DEFAULT_ARRANGE_SETTINGS, type ArrangeLayout, type ZoneMap, type ZoneMapThing } from '../src/protocol.ts';
import { boxPicture, buildZoneMap, laneTable } from '../src/zone-map.ts';

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
): ZoneMap {
  const { positions, clusters, size } = arrangeTiles(tiles, links, { by: 'issue', layout, width: 600, clusters: true, noteHeights });
  const things: ZoneMapThing[] = [
    ...tiles.map((tile) => ({ key: tile.id, itemKind: null, name: tile.name, state: tile.state, ...positions.get(tile.id)!, ...AGENT_TILE_SIZE })),
    ...clusters.flatMap((cluster) => [
      { key: `item:${cluster.key}-label`, itemKind: 'text', name: cluster.label, state: null, ...cluster.labelAt, ...CLUSTER_LABEL_SIZE },
      { key: `item:${cluster.key}-note`, itemKind: 'agent-note', name: 'note', state: null, ...cluster.noteAt, ...cluster.noteSize },
    ]),
  ].map(move);
  const parts = new Map(clusters.flatMap((cluster) => [[`${cluster.key}#label`, `item:${cluster.key}-label`] as const, [`${cluster.key}#note`, `item:${cluster.key}-note`] as const]));
  const arrange = { ...DEFAULT_ARRANGE_SETTINGS, layout };
  return { zoneId: 'z', name: 'web', ...size, arrange, things, ...buildZoneMap({ lanes: lanesOf(tiles, links), things, parts, arrange }) };
}

/** A ref as the CLI writes one: its kind and the start of its id. */
const ref = (key: string) => key.replace(/^(\w+):(.{0,10}).*$/, '$1:$2');

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
