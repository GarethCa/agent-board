import { describe, expect, it } from 'vitest';
import type { ArrangeTile } from '../src/board-arrange.ts';
import { AGENT_TILE_SIZE, overlaps, PERCH_ROOM, SPACING_GAPS, type Rect } from '../src/board-layout.ts';
import { layOutSpine, SPINE_GAPS, SPINE_MORE_CHIP_WIDTH } from '../src/spine-layout.ts';

const { width: TW, height: TH } = AGENT_TILE_SIZE;
const { tile: GAP, padding: PAD, lane: LANE } = SPACING_GAPS.normal;
const { across: UX, down: UY, band: BAND } = SPINE_GAPS.normal;
const CLOCK = { width: 256, height: 76 };

let started = 0;
const at = () => `2026-11-13T10:${String(started++).padStart(2, '0')}:00.000Z`;

function agent(id: string, fields: Partial<ArrangeTile> = {}): ArrangeTile {
  return { id: `agent:${id}`, name: id, kind: 'agent', role: 'implementer', issue: null, state: 'idle', reviewOf: null, lead: false, createdAt: at(), ...fields };
}
const lead = (fields: Partial<ArrangeTile> = {}) => agent('lead', { role: null, lead: true, ...fields });
const shell = (id: string): ArrangeTile => ({ id: `shell:${id}`, name: id, kind: 'shell', role: null, issue: null, state: null, reviewOf: null, lead: false, createdAt: at() });
const clock = (id: string): ArrangeTile => ({ id: `item:${id}`, name: 'clock', kind: 'clock', role: null, issue: null, state: null, reviewOf: null, lead: false, createdAt: at(), size: CLOCK });
const ticket = (n: number, fields: Partial<ArrangeTile> = {}) => agent(`i${n}`, { issue: `ACME-${n}`, ...fields });
const reviewer = (n: number) => agent(`r${n}`, { issue: `ACME-${n}`, role: 'reviewer', reviewOf: `agent:i${n}` });

const xy = (layout: ReturnType<typeof layOutSpine>, id: string) => {
  const spot = layout.positions.get(id);
  return spot === undefined ? undefined : [spot.x, spot.y];
};
/** Where the bands' tiles start across: the head's column, then the band gap and the band's own margin. */
const FIRST_LINE = PAD + TW + UX + BAND;
const TOP = PAD + PERCH_ROOM;
const BAND_STEP = PERCH_ROOM + TH + UY;

describe('layOutSpine', () => {
  it('stands the lead at the left, its shells stacked under it, and each ticket a band to the right', () => {
    const tiles = [lead(), shell('dev'), ticket(1), reviewer(1), ticket(2)];
    const layout = layOutSpine({ tiles, links: [], spacing: 'normal' });
    expect(xy(layout, 'agent:lead')).toEqual([PAD, TOP]);
    expect(xy(layout, 'shell:dev')).toEqual([PAD, TOP + TH + GAP]);
    // The agent, then its reviewer to the right: one band.
    expect(xy(layout, 'agent:i1')).toEqual([FIRST_LINE, TOP]);
    expect(xy(layout, 'agent:r1')).toEqual([FIRST_LINE + TW + GAP, TOP]);
    expect(xy(layout, 'agent:i2')).toEqual([FIRST_LINE, TOP + BAND_STEP]);
    expect(layout.bands.map((band) => [band.key, band.members, band.line])).toEqual([
      ['issue:ACME-1', ['agent:i1', 'agent:r1'], 0],
      ['issue:ACME-2', ['agent:i2'], 0],
    ]);
  });

  it('heads the column with a lead that stays where it is: its shells under it, the bands right of it', () => {
    const anchor: Rect = { x: 300, y: 200, width: TW, height: PERCH_ROOM + TH };
    const layout = layOutSpine({ tiles: [shell('dev'), ticket(1), ticket(2)], links: [], spacing: 'normal', fixed: [anchor], anchor });
    expect(xy(layout, 'shell:dev')).toEqual([300, 200 + PERCH_ROOM + TH + GAP + PERCH_ROOM]);
    expect(xy(layout, 'agent:i1')).toEqual([300 + TW + UX + BAND, TOP]);
    expect(xy(layout, 'agent:i2')).toEqual([300 + TW + UX + BAND, TOP + BAND_STEP]);
    expect(layout.size.width).toBe(300 + TW + UX + BAND + TW + PAD);
  });

  it('gives a reviewer whose implementer has gone a band of its own, with no empty slot', () => {
    const layout = layOutSpine({ tiles: [lead(), reviewer(3)], links: [], spacing: 'normal' });
    expect(xy(layout, 'agent:r3')).toEqual([FIRST_LINE, TOP]);
  });

  it('fills a column until it is as tall as the head column, and at least three bands, then starts the next', () => {
    const tiles = [lead(), ...[1, 2, 3, 4, 5].map((n) => ticket(n))];
    const layout = layOutSpine({ tiles, links: [], spacing: 'normal' });
    expect(layout.bands.map((band) => band.line)).toEqual([0, 0, 0, 1, 1]);
    expect(xy(layout, 'agent:i4')).toEqual([FIRST_LINE + TW + UX, TOP]);
    expect(xy(layout, 'agent:i5')).toEqual([FIRST_LINE + TW + UX, TOP + BAND_STEP]);
  });

  it('lets a tall head column (an expanded lead) take more bands in a column', () => {
    const tiles = [lead({ size: { width: 1060, height: 670 } }), ...[1, 2, 3, 4].map((n) => ticket(n))];
    const layout = layOutSpine({ tiles, links: [], spacing: 'normal' });
    expect(layout.bands.map((band) => band.line)).toEqual([0, 0, 0, 0]);
    expect(xy(layout, 'agent:i1')).toEqual([PAD + 1060 + UX + BAND, TOP]);
  });

  it('keeps each band in its column: one leaving moves only the bands under it up', () => {
    const before = [lead(), ...[1, 2, 3, 4, 5].map((n) => ticket(n))];
    const first = layOutSpine({ tiles: before, links: [], spacing: 'normal' });
    const after = layOutSpine({ tiles: before.filter((tile) => tile.id !== 'agent:i2'), links: [], spacing: 'normal', places: first.places });
    expect(xy(after, 'agent:i1')).toEqual(xy(first, 'agent:i1'));
    expect(xy(after, 'agent:i3')).toEqual(xy(first, 'agent:i2'));
    expect(xy(after, 'agent:i4')).toEqual(xy(first, 'agent:i4'));
    expect(xy(after, 'agent:i5')).toEqual(xy(first, 'agent:i5'));
  });

  it('puts a new ticket at the foot of the shortest column with room, or a new column on the right', () => {
    const tiles = [lead(), ...[1, 2, 3, 4].map((n) => ticket(n))];
    const first = layOutSpine({ tiles, links: [], spacing: 'normal' });
    expect(first.bands.map((band) => band.line)).toEqual([0, 0, 0, 1]);
    const added = layOutSpine({ tiles: [...tiles, ticket(5)], links: [], spacing: 'normal', places: first.places });
    expect(xy(added, 'agent:i5')).toEqual([FIRST_LINE + TW + UX, TOP + BAND_STEP]);
    const full = layOutSpine({ tiles: [...tiles, ticket(5), ticket(6), ticket(7)], links: [], spacing: 'normal', places: added.places });
    expect(full.bands.map((band) => band.line)).toEqual([0, 0, 0, 1, 1, 1, 2]);
  });

  it('drops an emptied column, so the ones right of it close up', () => {
    const tiles = [lead(), ...[1, 2, 3, 4].map((n) => ticket(n))];
    const first = layOutSpine({ tiles, links: [], spacing: 'normal' });
    expect(first.places['issue:ACME-4']).toEqual({ line: 1, rank: 0 });
    const left = layOutSpine({ tiles: [lead(), ticket(4)], links: [], spacing: 'normal', places: first.places });
    expect(xy(left, 'agent:i4')).toEqual([FIRST_LINE, TOP]);
    expect(left.places).toEqual({ 'issue:ACME-4': { line: 0, rank: 0 }, 'agent:i4': { line: 0, rank: 0 } });
  });

  it('keeps a band in its place when it gains a ticket', () => {
    const tiles = [lead(), ...['p', 'q', 'r', 's'].map((id) => agent(id))];
    const first = layOutSpine({ tiles, links: [], spacing: 'normal' });
    expect(first.bands.map((band) => band.line)).toEqual([0, 0, 0, 1]);
    const linked = tiles.map((tile) => (tile.id === 'agent:q' ? { ...tile, issue: 'ACME-7' } : tile));
    const after = layOutSpine({ tiles: linked, links: [], spacing: 'normal', places: first.places });
    for (const id of ['agent:p', 'agent:q', 'agent:r', 'agent:s']) expect(xy(after, id)).toEqual(xy(first, id));
    expect(after.places['issue:ACME-7']).toEqual({ line: 0, rank: 1 });
  });

  it("keeps a band in its place when its first tile goes and its reviewer stays", () => {
    const p = agent('p');
    const pr = agent('pr', { role: 'reviewer', reviewOf: 'agent:p' });
    const tiles = [lead(), p, pr, ...['q', 'r', 's'].map((id) => agent(id))];
    const first = layOutSpine({ tiles, links: [], spacing: 'normal' });
    // The four bands fill a column of three, then the next.
    expect(xy(first, 'agent:s')![0]).toBeGreaterThan(xy(first, 'agent:p')![0]!);
    const after = layOutSpine({ tiles: tiles.filter((tile) => tile !== p), links: [], spacing: 'normal', places: first.places });
    // Its key is now the reviewer's id, yet it stays at the top of its column, and none of the others leaves its own
    // (the next column only closes up to the narrower one).
    expect(xy(after, 'agent:pr')).toEqual(xy(first, 'agent:p'));
    for (const id of ['agent:q', 'agent:r']) expect(xy(after, id)).toEqual(xy(first, id));
    expect(after.places['agent:s']).toEqual(first.places['agent:s']);
    expect(xy(after, 'agent:s')![1]).toBe(xy(first, 'agent:s')![1]);
  });

  it("keeps a column's order when a band's earliest tile goes", () => {
    const i1 = ticket(1);
    const i2 = ticket(2);
    // Its reviewer started after the band under it.
    const tiles = [lead(), i1, i2, reviewer(1)];
    const first = layOutSpine({ tiles, links: [], spacing: 'normal' });
    expect(xy(first, 'agent:i1')).toEqual([FIRST_LINE, TOP]);
    const after = layOutSpine({ tiles: tiles.filter((tile) => tile !== i1), links: [], spacing: 'normal', places: first.places });
    expect(xy(after, 'agent:r1')).toEqual([FIRST_LINE, TOP]);
    expect(xy(after, 'agent:i2')).toEqual(xy(first, 'agent:i2'));
  });

  it('lays nothing over what stays put: a band goes down clear of a tile placed by hand', () => {
    const tiles = [lead(), agent('a'), agent('b')];
    const first = layOutSpine({ tiles, links: [], spacing: 'normal' });
    const [ax, ay] = xy(first, 'agent:a')!;
    // `a` dragged 10 px: it stays where it was put, with its character's perch above it.
    const dragged: Rect = { x: ax! + 10, y: ay! + 10 - PERCH_ROOM, width: TW, height: TH + PERCH_ROOM };
    const after = layOutSpine({ tiles: tiles.filter((tile) => tile.id !== 'agent:a'), links: [], spacing: 'normal', places: first.places, fixed: [dragged] });
    const [bx, by] = xy(after, 'agent:b')!;
    expect(bx).toBe(ax);
    expect(by).toBe(dragged.y + dragged.height + GAP + PERCH_ROOM);
    expect(after.size.height).toBe(by! + TH + PAD);
  });

  it('lays no tile, band or clock over a note near the top-left', () => {
    const tiles = [lead(), shell('dev'), ticket(1), reviewer(1), ticket(2), clock('c1'), clock('c2')];
    const note: Rect = { x: 30, y: 30, width: 200, height: 160 };
    const layout = layOutSpine({ tiles, links: [], spacing: 'normal', fixed: [note] });
    const size = (id: string) => (id.startsWith('item:') ? CLOCK : { width: TW, height: TH });
    for (const [id, spot] of layout.positions) {
      const perch = id.startsWith('item:') ? 0 : PERCH_ROOM;
      expect(overlaps({ x: spot.x, y: spot.y - perch, ...size(id), height: size(id).height + perch }, note), id).toBe(false);
    }
    for (const band of layout.bands) expect(overlaps(band.rect, note), band.key).toBe(false);
  });

  it('runs the clocks along the top within the width the tiles need, and the tiles below them', () => {
    const tiles = [lead(), ticket(1), clock('c1'), clock('c2')];
    const layout = layOutSpine({ tiles, links: [], spacing: 'normal' });
    expect(xy(layout, 'item:c1')).toEqual([PAD, PAD]);
    expect(xy(layout, 'item:c2')).toEqual([PAD + CLOCK.width + GAP, PAD]);
    const below = PAD + CLOCK.height + LANE;
    expect(xy(layout, 'agent:lead')).toEqual([PAD, below]);
    expect(xy(layout, 'agent:i1')).toEqual([FIRST_LINE, below]);
    expect(layout.more).toBeNull();
  });

  it('shows the clocks that fit, then a +N chip, and never widens the zone for them', () => {
    const tiles = [lead(), ticket(1), reviewer(1), ...['c1', 'c2', 'c3', 'c4'].map(clock)];
    const layout = layOutSpine({ tiles, links: [], spacing: 'normal' });
    const content = FIRST_LINE + TW + GAP + TW;
    // Two clocks and the chip fit in the width the tiles take; three would not.
    expect(xy(layout, 'item:c2')).toEqual([PAD + CLOCK.width + GAP, PAD]);
    expect(layout.more).toEqual({ x: PAD + 2 * (CLOCK.width + GAP), y: PAD, width: SPINE_MORE_CHIP_WIDTH, height: CLOCK.height, hidden: ['item:c3', 'item:c4'] });
    expect(xy(layout, 'item:c3')).toEqual([layout.more!.x, PAD]);
    expect(layout.size.width).toBe(content + PAD);
  });

  it('shows the first clock, then the chip, when the zone holds only clocks', () => {
    const layout = layOutSpine({ tiles: ['c1', 'c2', 'c3'].map(clock), links: [], spacing: 'normal' });
    expect(xy(layout, 'item:c1')).toEqual([PAD, PAD]);
    expect(layout.more).toEqual({ x: PAD + CLOCK.width + GAP, y: PAD, width: SPINE_MORE_CHIP_WIDTH, height: CLOCK.height, hidden: ['item:c2', 'item:c3'] });
    expect(xy(layout, 'item:c2')).toEqual([layout.more!.x, PAD]);
  });

  it('keeps clocks made in the same millisecond in the order it was given them, whatever their ids', () => {
    // Made one after another, in one millisecond; their random ids sort the other way.
    const same = '2026-11-13T11:00:00.000Z';
    const made = ['zz', 'mm', 'aa'].map((id) => ({ ...clock(id), createdAt: same }));
    const layout = layOutSpine({ tiles: made, links: [], spacing: 'normal' });
    expect(xy(layout, 'item:zz')).toEqual([PAD, PAD]);
    expect(layout.more?.hidden).toEqual(['item:mm', 'item:aa']);
  });

  it('hugs its tiles: as small as what it holds, and what stays put', () => {
    const tiles = [lead(), ticket(1)];
    const layout = layOutSpine({ tiles, links: [], spacing: 'normal' });
    expect(layout.size).toEqual({ width: FIRST_LINE + TW + PAD, height: TOP + TH + PAD });
    const fixed: Rect = { x: 900, y: 500, width: 100, height: 100 };
    expect(layOutSpine({ tiles, links: [], spacing: 'normal', fixed: [fixed] }).size).toEqual({ width: 1000 + PAD, height: 600 + PAD });
  });

  it('lays out the same crew the same way, whatever order it is given in', () => {
    const tiles = [lead(), shell('dev'), ticket(1), reviewer(1), ticket(2), clock('c1')];
    const a = layOutSpine({ tiles, links: [], spacing: 'compact' });
    const b = layOutSpine({ tiles: tiles.toReversed(), links: [], spacing: 'compact' });
    expect([...b.positions].toSorted()).toEqual([...a.positions].toSorted());
  });

  it('starts the bands at the left when the zone has no head column', () => {
    const layout = layOutSpine({ tiles: [ticket(1)], links: [], spacing: 'normal' });
    expect(xy(layout, 'agent:i1')).toEqual([PAD + BAND, TOP]);
  });

  it("stands what an agent gathered at its band's tail, so the band (and its column) is that much wider", () => {
    const note = { id: 'item:n1', size: { width: 240, height: 100 } };
    const tiles = [lead(), ticket(1), reviewer(1), ticket(2), ticket(3), ticket(4)];
    const layout = layOutSpine({ tiles, links: [], spacing: 'normal', tails: new Map([['agent:i1', [note]]]) });
    expect(xy(layout, 'item:n1')).toEqual([FIRST_LINE + 2 * (TW + GAP), TOP]);
    expect(layout.bands[0]!.rect.width).toBe(2 * (TW + GAP) + 240);
    // The next column starts right of the widest band, its tail included.
    expect(xy(layout, 'agent:i4')).toEqual([FIRST_LINE + 2 * (TW + GAP) + 240 + UX, TOP]);
  });

  it("stacks the lead's own things at the foot of its column, under its shells", () => {
    const list = { id: 'item:todo', size: { width: 260, height: 120 } };
    const layout = layOutSpine({ tiles: [lead(), shell('dev'), ticket(1)], links: [], spacing: 'normal', tails: new Map([['agent:lead', [list]]]) });
    expect(xy(layout, 'item:todo')).toEqual([PAD, TOP + TH + GAP + TH + GAP]);
    expect(layout.size.height).toBe(TOP + TH + GAP + TH + GAP + 120 + PAD);
  });

  it('lays the Done line under the band columns, as wide as they are', () => {
    const tiles = [lead(), ticket(1), reviewer(1), ticket(2)];
    const layout = layOutSpine({ tiles, links: [], spacing: 'normal', doneLine: { height: 40 } });
    expect(layout.doneLine).toEqual({ x: FIRST_LINE, y: TOP - PERCH_ROOM + 2 * BAND_STEP, width: 2 * TW + GAP, height: 40 });
    expect(layout.size.height).toBe(TOP - PERCH_ROOM + 2 * BAND_STEP + 40 + PAD);
  });

  it('gives no Done line unless asked, and a least width with no bands', () => {
    expect(layOutSpine({ tiles: [lead(), ticket(1)], links: [], spacing: 'normal' }).doneLine).toBeNull();
    const alone = layOutSpine({ tiles: [lead()], links: [], spacing: 'normal', doneLine: { height: 40 } });
    expect(alone.doneLine).toEqual({ x: FIRST_LINE, y: TOP - PERCH_ROOM, width: TW, height: 40 });
  });
});
