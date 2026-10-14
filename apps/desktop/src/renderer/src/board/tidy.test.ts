import { describe, expect, it } from 'vitest';
import { overlaps } from '../geometry';
import { AGENT_TILE_SIZE, PERCH_ROOM, TILE_GAP, tileSlot, ZONE_PADDING, zoneHeightFor } from './layout';
import { tidyLoose, tidyZone } from './tidy';

const STEP = { x: AGENT_TILE_SIZE.width + TILE_GAP, y: PERCH_ROOM + AGENT_TILE_SIZE.height + TILE_GAP };

describe('tidyZone', () => {
  it("lays a zone's tiles out in rows, in reading order, keeping its width and fitting its height to them", () => {
    const tiles = [
      { id: 'low-left', x: 30, y: 600 },
      { id: 'top-right', x: 500, y: 50 },
      { id: 'top-left', x: 40, y: 60 },
      { id: 'middle', x: 300, y: 300 },
    ];
    const { positions, size } = tidyZone({ width: 720, height: 1200 }, tiles);
    expect(positions).toEqual(
      new Map([
        ['top-left', tileSlot(0, 720)],
        ['top-right', tileSlot(1, 720)],
        ['middle', tileSlot(2, 720)],
        ['low-left', tileSlot(3, 720)],
      ]),
    );
    expect(size).toEqual({ width: 720, height: zoneHeightFor(4, 720) });
  });

  it('breaks a tie in reading order by id, so the same zone always tidies the same way', () => {
    const tiles = [
      { id: 'b', x: 100, y: 100 },
      { id: 'a', x: 100, y: 100 },
    ];
    expect([...tidyZone({ width: 720, height: 480 }, tiles).positions.keys()]).toEqual(['a', 'b']);
    expect([...tidyZone({ width: 720, height: 480 }, tiles.toReversed()).positions.keys()]).toEqual(['a', 'b']);
  });

  it('leaves room round the notes and cards in the zone, and stays tall enough to hold them', () => {
    const note = { x: tileSlot(1, 1000).x, y: 40, width: 200, height: 600 };
    const tiles = [0, 1, 2].map((index) => ({ id: `t${index}`, x: index * 10, y: 0 }));
    const { positions, size } = tidyZone({ width: 1000, height: 300 }, tiles, [note]);
    for (const spot of positions.values()) {
      expect(overlaps({ ...spot, y: spot.y - PERCH_ROOM, width: AGENT_TILE_SIZE.width, height: AGENT_TILE_SIZE.height + PERCH_ROOM }, note)).toBe(false);
    }
    expect(size.height).toBeGreaterThanOrEqual(note.y + note.height + ZONE_PADDING);
  });

  it('is never narrower than one tile', () => {
    expect(tidyZone({ width: 100, height: 100 }, [{ id: 'a', x: 0, y: 0 }]).size).toEqual({
      width: 2 * ZONE_PADDING + AGENT_TILE_SIZE.width,
      height: zoneHeightFor(1, 100),
    });
  });

  it('leaves a zone with no tiles as it is: there is nothing to fit it to', () => {
    expect(tidyZone({ width: 720, height: 900 }, [], [{ x: 40, y: 40, width: 200, height: 200 }])).toEqual({
      positions: new Map(),
      size: { width: 720, height: 900 },
    });
  });
});

describe('tidyLoose', () => {
  it('lays the loose tiles out in a square-ish grid from the top-left of where they are, in reading order', () => {
    const tiles = [
      { id: 'd', x: 900, y: 900 },
      { id: 'a', x: 100, y: 200 },
      { id: 'c', x: 50, y: 700 },
      { id: 'b', x: 600, y: 210 },
      { id: 'e', x: 400, y: 1500 },
    ];
    const origin = { x: 50, y: 200 };
    expect(tidyLoose(tiles)).toEqual(
      new Map([
        ['a', origin],
        ['b', { x: origin.x + STEP.x, y: origin.y }],
        ['c', { x: origin.x + 2 * STEP.x, y: origin.y }],
        ['d', { x: origin.x, y: origin.y + STEP.y }],
        ['e', { x: origin.x + STEP.x, y: origin.y + STEP.y }],
      ]),
    );
  });

  it('skips the spots a zone or item takes', () => {
    const tiles = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 400, y: 0 },
    ];
    const zone = { x: STEP.x + 20, y: -100, width: 500, height: 300 };
    const positions = tidyLoose(tiles, [zone]);
    expect(positions.get('a')).toEqual({ x: 0, y: 0 });
    const b = positions.get('b')!;
    expect(overlaps({ ...b, y: b.y - PERCH_ROOM, width: AGENT_TILE_SIZE.width, height: AGENT_TILE_SIZE.height + PERCH_ROOM }, zone)).toBe(false);
    expect(b).toEqual({ x: 0, y: STEP.y });
  });

  it('has nothing to do with no tiles', () => {
    expect(tidyLoose([])).toEqual(new Map());
  });
});
