import { describe, expect, it } from 'vitest';
import { getBezierPath, getSmoothStepPath, getStraightPath, Position } from '@xyflow/react';
import type { ConnectorSide } from '@agent-board/daemon/protocol';
import { bendsFromBoard, bendsOnBoard, labelFits, lineShape, pointAlong, samplePath, withoutPoint, withPointOn } from './geometry';

const ends = { source: { x: 0, y: 0 }, sourceSide: 'right', target: { x: 200, y: 100 }, targetSide: 'left' } as const;

describe('a line with no bends', () => {
  it("draws each style as React Flow's own path does, its label where React Flow puts it", () => {
    const flow = { sourceX: 0, sourceY: 0, targetX: 200, targetY: 100, sourcePosition: Position.Right, targetPosition: Position.Left };
    const expected = {
      straight: getStraightPath(flow),
      elbow: getSmoothStepPath({ ...flow, borderRadius: 0 }),
      curved: getBezierPath(flow),
    };
    for (const style of ['straight', 'elbow', 'curved'] as const) {
      const shape = lineShape(style, ends, []);
      const [path, labelX, labelY] = expected[style];
      expect(shape.path).toBe(path);
      expect(shape.label).toEqual({ x: labelX, y: labelY });
    }
  });

  it('offers one place to add a bend, halfway along it', () => {
    const shape = lineShape('straight', ends, []);
    expect(shape.inserts).toHaveLength(1);
    expect(shape.inserts[0]!.x).toBeCloseTo(100);
    expect(shape.inserts[0]!.y).toBeCloseTo(50);
    expect(shape.length).toBeCloseTo(Math.hypot(200, 100));
  });

  it("moves that place along the line clear of its label, which a press on it must reach", () => {
    const flat = { ...ends, target: { x: 200, y: 0 } };
    const [insert] = lineShape('straight', flat, [], { width: 100, height: 20 }).inserts;
    expect(Math.abs(insert!.x - 100)).toBeGreaterThan(50);
    expect(insert!.y).toBeCloseTo(0);
  });
});

describe('a line with bends', () => {
  const points = [{ x: 100, y: -50 }];

  it('goes straight through each bend', () => {
    const shape = lineShape('straight', ends, points);
    expect(shape.path).toBe('M0,0 L100,-50 L200,100');
    expect(shape.length).toBeCloseTo(Math.hypot(100, 50) + Math.hypot(100, 150));
    expect(shape.inserts).toHaveLength(2);
    expect(shape.inserts[0]!.x).toBeCloseTo(50);
    expect(shape.inserts[0]!.y).toBeCloseTo(-25);
  });

  it('turns square corners on an elbow, leaving along its side and arriving along the other end\'s', () => {
    // Out of the right side: across, then up to the bend; then across, down, and into the left side across.
    expect(lineShape('elbow', ends, points).path).toBe('M0,0 L20,0 L100,0 L100,-50 L180,-50 L180,100 L200,100');
    // Out of the bottom with the bend above: a stub down out of the side, then across and up, never back through it.
    expect(lineShape('elbow', { ...ends, sourceSide: 'bottom' }, points).path).toBe('M0,0 L0,20 L100,20 L100,-50 L180,-50 L180,100 L200,100');
  });

  it('puts its label halfway along it', () => {
    const shape = lineShape('straight', { ...ends, target: { x: 100, y: 100 } }, [{ x: 100, y: 0 }]);
    expect(shape.label.x).toBeCloseTo(100);
    expect(shape.label.y).toBeCloseTo(0);
  });
});

describe('where bends are kept', () => {
  it('from the middle of the line\'s ends, so they move with its objects when both move, and halfway when one does', () => {
    const at = { source: { x: 0, y: 0 }, target: { x: 200, y: 100 } };
    const kept = bendsFromBoard([{ x: 100, y: -50 }], at);
    expect(kept).toEqual([{ x: 0, y: -100 }]);
    expect(bendsOnBoard(kept, at)).toEqual([{ x: 100, y: -50 }]);
    // Both objects moved by (40, 30): the bend with them.
    expect(bendsOnBoard(kept, { source: { x: 40, y: 30 }, target: { x: 240, y: 130 } })).toEqual([{ x: 140, y: -20 }]);
    // Only the target, by (40, 0): the bend by half that.
    expect(bendsOnBoard(kept, { source: { x: 0, y: 0 }, target: { x: 240, y: 100 } })).toEqual([{ x: 120, y: -50 }]);
  });
});

describe('editing bends', () => {
  it('adds a bend on a stretch, in order, and takes one away', () => {
    const points = [{ x: 1, y: 1 }, { x: 2, y: 2 }];
    expect(withPointOn(points, 0, { x: 9, y: 9 })).toEqual([{ x: 9, y: 9 }, ...points]);
    expect(withPointOn(points, 2, { x: 9, y: 9 })).toEqual([...points, { x: 9, y: 9 }]);
    expect(withoutPoint(points, 0)).toEqual([{ x: 2, y: 2 }]);
  });
});

describe('the path', () => {
  it('is sampled from its moves, lines, cubic and quadratic curves', () => {
    expect(samplePath('M0,0 L10,0 L10,10')).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    const curve = samplePath('M0 0Q 10,0 10,10');
    expect(curve[0]).toEqual({ x: 0, y: 0 });
    expect(curve.at(-1)).toEqual({ x: 10, y: 10 });
    expect(curve.length).toBeGreaterThan(3);
  });

  it('finds the point a share of the way along it', () => {
    const along = pointAlong([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 0.75);
    expect(along.x).toBeCloseTo(10);
    expect(along.y).toBeCloseTo(5);
  });
});

describe('whether a label fits', () => {
  const label = { width: 120, height: 24 };
  it('fits only with room for the arrowheads either side of it, along the line', () => {
    expect(labelFits({ length: 200, along: { x: 1, y: 0 } }, label)).toBe(true);
    expect(labelFits({ length: 130, along: { x: 1, y: 0 } }, label)).toBe(false);
    // Up and down, it takes only its height of the line.
    expect(labelFits({ length: 130, along: { x: 0, y: 1 } }, label)).toBe(true);
    expect(labelFits({ length: 60, along: { x: 0, y: 1 } }, label)).toBe(false);
  });

  it("goes by the way the line runs at its middle, where the label sits", () => {
    const run = lineShape('straight', { source: { x: 0, y: 0 }, sourceSide: 'bottom', target: { x: 0, y: 130 }, targetSide: 'top' }, []);
    expect(run.along.x).toBeCloseTo(0);
    expect(run.along.y).toBeCloseTo(1);
    expect(labelFits(run, label)).toBe(true);
  });
});

describe('a bent line, for every pair of sides', () => {
  const SIDES: ConnectorSide[] = ['top', 'right', 'bottom', 'left'];
  const OUT: Record<ConnectorSide, { x: number; y: number }> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
  // Bends ahead of the source, level with it, behind it, beside the target, and two at once.
  const BENDS = [[{ x: 150, y: 100 }], [{ x: 0, y: 200 }], [{ x: -150, y: 0 }], [{ x: 300, y: 260 }], [{ x: 150, y: -100 }, { x: 250, y: 250 }]];
  const source = { x: 0, y: 0 };
  const target = { x: 300, y: 200 };
  /** The way the line goes from sample `from`, towards the next one off it in `step`'s direction. */
  const heading = (samples: { x: number; y: number }[], from: number, step: number) => {
    const at = samples[from]!;
    let index = from + step;
    while (samples[index] !== undefined && Math.hypot(samples[index]!.x - at.x, samples[index]!.y - at.y) < 1e-6) index += step;
    const next = samples[index]!;
    const length = Math.hypot(next.x - at.x, next.y - at.y);
    return { x: (next.x - at.x) / length, y: (next.y - at.y) / length };
  };
  const dot = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x * b.x + a.y * b.y;
  const unit = (x: number, y: number) => ({ x: x / Math.hypot(x, y), y: y / Math.hypot(x, y) });
  /** The way a curved path sets out from its start, and the way back out of its end along its last control point. */
  const curveEnds = (path: string): [{ x: number; y: number }, { x: number; y: number }] => {
    const n = (path.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    const [x0, y0, c1x, c1y] = n;
    const [c2x, c2y, ex, ey] = n.slice(-4);
    return [unit(c1x! - x0!, c1y! - y0!), unit(c2x! - ex!, c2y! - ey!)];
  };

  for (const style of ['curved', 'elbow'] as const) {
    it(`${style}: leaves out of its side, arrives into the other's, and passes through every bend`, () => {
      for (const sourceSide of SIDES) {
        for (const targetSide of SIDES) {
          for (const points of BENDS) {
            const shape = lineShape(style, { source, sourceSide, target, targetSide }, points);
            const samples = samplePath(shape.path);
            const named = `${style} ${sourceSide}→${targetSide} through ${JSON.stringify(points)}: ${shape.path}`;
            // Square out of the source's side, and square into the target's (the arrowhead points into it): a curve's
            // tangents there are along its first and last control points, an elbow's along its first and last stretches.
            const [first, last] = style === 'curved' ? curveEnds(shape.path) : [heading(samples, 0, 1), heading(samples, samples.length - 1, -1)];
            expect(dot(first, OUT[sourceSide]), named).toBeGreaterThan(0.999);
            expect(dot(last, OUT[targetSide]), named).toBeGreaterThan(0.999);
            for (const bend of points) expect(samples.some((at) => Math.hypot(at.x - bend.x, at.y - bend.y) < 0.01), named).toBe(true);
            if (style === 'elbow') {
              // Every stretch is across or up and down.
              for (const [index, at] of samples.slice(1).entries()) {
                const before = samples[index]!;
                expect(Math.abs(at.x - before.x) < 1e-6 || Math.abs(at.y - before.y) < 1e-6, named).toBe(true);
              }
            }
          }
        }
      }
    });
  }
});
