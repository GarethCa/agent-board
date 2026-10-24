import { describe, expect, it } from 'vitest';
import { clearOf, GRID_COLUMN, gridPoint, sizedFootprint, AGENT_TILE_SIZE, zoneGrid, type Rect } from '../src/board-layout.ts';
import { makeRoom } from '../src/board-room.ts';

const tile = (column: number, row: number): Rect => sizedFootprint(gridPoint(column, row), AGENT_TILE_SIZE);

describe('makeRoom', () => {
  it('moves nothing when nothing is in the way', () => {
    expect(makeRoom(tile(2, 0), [{ id: 'a', rect: tile(0, 0) }], []).size).toBe(0);
  });

  it('pushes what is in the way right a whole grid column at a time, and what that then hits, keeping their order', () => {
    // A row: sticky-ish a, impl b, reviewer c, and d in the next row, untouched.
    const row = [
      { id: 'b', rect: tile(1, 0) },
      { id: 'c', rect: tile(2, 0) },
      { id: 'a', rect: tile(0, 0) },
      { id: 'd', rect: tile(1, 1) },
    ];
    const moved = makeRoom(tile(1, 0), row, []);
    expect([...moved].sort()).toEqual([
      ['b', { x: tile(2, 0).x, y: tile(2, 0).y }],
      ['c', { x: tile(3, 0).x, y: tile(3, 0).y }],
    ]);
  });

  it('pushes past what may not move, and leaves everything clear of the placed rect, of what is fixed, and of each other', () => {
    const fixed = [tile(2, 0)];
    const others = [{ id: 'a', rect: tile(0, 0) }, { id: 'b', rect: { x: tile(1, 0).x + 40, y: tile(1, 0).y, width: 300, height: 100 } }];
    const placed = tile(0, 0);
    const moved = makeRoom(placed, others, fixed);
    const after = others.map((each) => ({ ...each.rect, ...moved.get(each.id) }));
    const all = [placed, ...fixed, ...after];
    all.forEach((rect, index) => expect(clearOf(rect, all.filter((_, other) => other !== index))).toBe(true));
    expect(moved.get('a')!.x - tile(0, 0).x).toBe(GRID_COLUMN);
    expect(moved.get('b')!.x).toBeGreaterThan(moved.get('a')!.x);
  });

  it('gives up searching after its cap and puts what is still in the way past everything', () => {
    const wall = Array.from({ length: 5 }, (_, index) => tile(index + 1, 0));
    const moved = makeRoom(tile(0, 0), [{ id: 'a', rect: tile(0, 0) }], wall, 3);
    const right = Math.max(...wall.map((rect) => rect.x + rect.width));
    expect(moved.get('a')!.x).toBeGreaterThan(right);
    expect(Number.isInteger((moved.get('a')!.x - gridPoint(0, 0).x) / GRID_COLUMN)).toBe(true);
  });

  it("pushes what is in the way a whole column of its zone's grid at a time", () => {
    const roomy = zoneGrid('roomy');
    const at = (column: number) => sizedFootprint(gridPoint(column, 0, roomy), AGENT_TILE_SIZE);
    const moved = makeRoom(at(0), [{ id: 'a', rect: at(0) }], [], undefined, roomy);
    expect(moved.get('a')).toEqual({ x: gridPoint(1, 0, roomy).x, y: at(0).y });
  });
});
