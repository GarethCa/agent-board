import { describe, expect, it } from 'vitest';
import { getBezierPath, getSmoothStepPath, getStraightPath, Position } from '@xyflow/react';
import type { ConnectorSide } from '@agent-board/daemon/protocol';
import { bendsFromBoard, bendsOnBoard, distanceAlong, endLabelAt, lineShape, pointAlong, samplePath, withoutPoint, withPointOn } from './geometry';

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

describe("a curve's bow", () => {
  const across = { source: { x: 0, y: 0 }, sourceSide: 'right', target: { x: 300, y: 0 }, targetSide: 'left' } as const;

  it('sits halfway along a curve never bowed, where its label is', () => {
    const shape = lineShape('curved', across, []);
    expect(shape.bow.x).toBeCloseTo(150);
    expect(shape.bow.y).toBeCloseTo(0);
    expect(shape.bow).toEqual(shape.label);
  });

  const SIDES: ConnectorSide[] = ['top', 'right', 'bottom', 'left'];
  it('draws the same curve bowed through its own middle as never bowed, for every pair of sides: grabbing the bow moves nothing', () => {
    for (const sourceSide of SIDES) {
      for (const targetSide of SIDES) {
        const ends = { source: { x: 0, y: 0 }, sourceSide, target: { x: 300, y: 150 }, targetSide };
        const unbowed = lineShape('curved', ends, []);
        const bowed = lineShape('curved', ends, [{ ...unbowed.bow, bow: true }]);
        const [before, after] = [samplePath(unbowed.path), samplePath(bowed.path)];
        expect(after).toHaveLength(before.length);
        for (const [index, at] of after.entries()) expect(Math.hypot(at.x - before[index]!.x, at.y - before[index]!.y), `${sourceSide}→${targetSide}`).toBeLessThan(1);
      }
    }
  });

  it('passes through the bow halfway along its curve, for every pair of sides', () => {
    for (const sourceSide of SIDES) {
      for (const targetSide of SIDES) {
        const bow = { x: 120, y: 200, bow: true as const };
        const shape = lineShape('curved', { source: { x: 0, y: 0 }, sourceSide, target: { x: 300, y: 150 }, targetSide }, [bow]);
        expect(samplePath(shape.path).some((at) => Math.hypot(at.x - bow.x, at.y - bow.y) < 0.01), `${sourceSide}→${targetSide}`).toBe(true);
      }
    }
  });

  it('sits on the point it was pulled to, which the curve passes through', () => {
    const shape = lineShape('curved', across, [{ x: 150, y: 80, bow: true }]);
    expect(shape.bow).toEqual({ x: 150, y: 80, bow: true });
    expect(samplePath(shape.path).some((at) => Math.hypot(at.x - 150, at.y - 80) < 0.01)).toBe(true);
  });

  it('has its handle on the bow, or along the curve clear of a label on it', () => {
    expect(lineShape('curved', across, [{ x: 150, y: 80, bow: true }]).bowHandle).toEqual({ x: 150, y: 80, bow: true });
    const { bow, bowHandle } = lineShape('curved', across, [], { width: 80, height: 20 });
    expect(Math.abs(bowHandle.x - bow.x)).toBeGreaterThan(40);
  });

  it('sits halfway along a curve bent through several points before it had a bow', () => {
    const shape = lineShape('curved', across, [{ x: 100, y: 50 }, { x: 200, y: -50 }]);
    const halfway = pointAlong(samplePath(shape.path), 0.5);
    expect(shape.bow.x).toBeCloseTo(halfway.x);
    expect(shape.bow.y).toBeCloseTo(halfway.y);
  });
});

describe('a curve kept with one bend, from before it could be bowed', () => {
  // As the board drew them before bows (a Catmull-Rom curve through the bend, square out of and into its sides), from
  // the code it drew them with: a board kept then must look the same now.
  const KEPT = [
    {
      ends: { source: { x: 0, y: 0 }, sourceSide: 'right', target: { x: 300, y: 150 }, targetSide: 'left' },
      bend: { x: 150, y: 200 },
      drawn: 'M0,0 C83.333,0 100,175 150,200 C200,225 247.295,150 300,150',
    },
    {
      ends: { source: { x: 0, y: 0 }, sourceSide: 'bottom', target: { x: 400, y: 0 }, targetSide: 'bottom' },
      bend: { x: 200, y: 160 },
      drawn: 'M0,0 C0,85.375 133.333,160 200,160 C266.667,160 400,85.375 400,0',
    },
    {
      ends: { source: { x: 0, y: 0 }, sourceSide: 'right', target: { x: 300, y: 0 }, targetSide: 'right' },
      bend: { x: 360, y: -80 },
      drawn: 'M0,0 C90,0 310,-80 360,-80 C410,-80 333.333,0 300,0',
    },
  ] as const;

  it('draws exactly as it was drawn then, through its bend', () => {
    for (const { ends, bend, drawn } of KEPT) expect(lineShape('curved', ends, [bend]).path).toBe(drawn);
  });

  it('has its bow handle on its bend', () => {
    for (const { ends, bend } of KEPT) expect(lineShape('curved', ends, [bend]).bow).toEqual(bend);
  });
});

describe('a label at an end', () => {
  const size = { width: 20, height: 14 };
  const near = (point: { x: number; y: number }, x: number, y: number) => {
    expect(point.x).toBeCloseTo(x, 1);
    expect(point.y).toBeCloseTo(y, 1);
  };

  it('sits just along the line from its end, clear of the end, to the line’s right going from `from` to `to`', () => {
    const across = samplePath('M0,0 L200,0');
    near(endLabelAt(across, 'from', size), 26, 13);
    near(endLabelAt(across, 'to', size), 174, 13);
    const down = samplePath('M0,0 L0,200');
    near(endLabelAt(down, 'from', size), -16, 23);
    near(endLabelAt(down, 'to', size), -16, 177);
  });

  it('follows the way the line goes near its end, such as a route round an object', () => {
    const routed = samplePath('M0,0 L100,0 L100,100');
    near(endLabelAt(routed, 'from', size), 26, 13);
    near(endLabelAt(routed, 'to', size), 84, 77);
  });

  /** Whether the box of `size` centred on `at` is clear of every stretch of `samples`, by the gap a label keeps. */
  const clearOfLine = (samples: readonly { x: number; y: number }[], at: { x: number; y: number }, box: { width: number; height: number }) => {
    const [left, right, top, bottom] = [at.x - box.width / 2, at.x + box.width / 2, at.y - box.height / 2, at.y + box.height / 2];
    return samples.slice(1).every((to, index) => {
      const from = samples[index]!;
      // Fine steps along each stretch: none of them inside the box.
      return Array.from({ length: 51 }, (_, step) => ({ x: from.x + ((to.x - from.x) * step) / 50, y: from.y + ((to.y - from.y) * step) / 50 })).every(
        (point) => point.x < left || point.x > right || point.y < top || point.y > bottom,
      );
    });
  };

  it('keeps off the line where its last stretch is too short to sit beside, on the outside of the corner', () => {
    const box = { width: 30, height: 16 };
    for (const path of ['M0,0 L100,0 L100,20', 'M0,0 L100,0 L100,30', 'M0,0 L100,0 L100,-20', 'M0,0 L0,100 L20,100', 'M0,0 L100,0 L100,8', 'M0,0 L100,0 L100,60']) {
      const samples = samplePath(path);
      const at = endLabelAt(samples, 'to', box);
      expect(clearOfLine(samples, at, box), `${path}: ${at.x},${at.y}`).toBe(true);
    }
    // Its start too, on a line that turns soon after it.
    const turning = samplePath('M100,20 L100,0 L0,0');
    expect(clearOfLine(turning, endLabelAt(turning, 'from', box), box)).toBe(true);
  });

  it('keeps each end’s label to its own half of a short line, so the two never pass each other', () => {
    const short = samplePath('M0,0 L40,0');
    const [from, to] = [endLabelAt(short, 'from', size), endLabelAt(short, 'to', size)];
    expect(from.x).toBeLessThanOrEqual(to.x);
    expect(from.x + size.width / 2).toBeLessThanOrEqual(20.01);
    expect(to.x - size.width / 2).toBeGreaterThanOrEqual(19.99);
  });
});

describe('how far along a line a point is', () => {
  it('is measured along the line to the nearest point on it, round its corners', () => {
    const routed = samplePath('M0,0 L100,0 L100,100 L0,100');
    expect(distanceAlong(routed, { x: 50, y: -4 })).toBeCloseTo(50, 1);
    expect(distanceAlong(routed, { x: 104, y: 50 })).toBeCloseTo(150, 1);
    // Near its start in space, but at the far end of a U along it.
    expect(distanceAlong(routed, { x: 2, y: 103 })).toBeCloseTo(298, 1);
  });
});
