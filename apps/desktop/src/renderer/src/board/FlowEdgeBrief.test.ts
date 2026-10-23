import { getBezierPath, Position } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import type { Rect } from '../geometry';
import { samplePath } from './connectors/geometry';
import { crossesAny, ROUTE_CLEARANCE, routeLine } from './connectors/route';
import { briefLine } from './FlowEdge';

/** An issue card, an agent's tile 600 to its right, and the tile between them. */
const card: Rect = { x: 0, y: 40, width: 240, height: 120 };
const agent: Rect = { x: 600, y: 40, width: 256, height: 136 };
const between: Rect = { x: 320, y: 20, width: 200, height: 160 };
const ends = { source: { x: 240, y: 100 }, sourceSide: 'right', target: { x: 600, y: 108 }, targetSide: 'left' } as const;
const [plain, x, y] = getBezierPath({ sourceX: 240, sourceY: 100, sourcePosition: Position.Right, targetX: 600, targetY: 108, targetPosition: Position.Left });
const own = { source: card, target: agent };
const lineWith = (others: Rect[]) => briefLine(ends, plain, { x, y }, routeLine(ends, samplePath(plain), others, own));

describe('the line from an issue card to its agent', () => {
  it('is the plain curve, its pill on the middle, with nothing in its way', () => {
    expect(lineWith([])).toEqual({ path: plain, pill: { x, y } });
  });

  it('goes round a tile between them, 16 px clear, its pill on the line it takes', () => {
    const line = lineWith([between]);
    expect(line.path).not.toBe(plain);
    expect(crossesAny(samplePath(line.path), [between])).toBe(false);
    // Clear of the tile by the margin, bar the rounding of its corners.
    const samples = samplePath(line.path);
    expect(samples.every((point) => point.y <= between.y - ROUTE_CLEARANCE + 1 || point.y >= between.y + between.height + ROUTE_CLEARANCE - 1 || point.x <= between.x - ROUTE_CLEARANCE + 1 || point.x >= between.x + between.width + ROUTE_CLEARANCE - 1)).toBe(true);
    expect(line.pill).not.toEqual({ x, y });
  });
});
