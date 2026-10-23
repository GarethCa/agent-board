import { describe, expect, it } from 'vitest';
import { SHAPE_TYPES } from '@agent-board/daemon/protocol';
import { SHAPE_GROUPS, SHAPES } from './catalogue';
import { fitParts, mapPath } from './geometry';

const box = { x: 10, y: 20, width: 200, height: 100 };

describe('fitParts', () => {
  it("stretches the mock's frame onto the box, keeping circles round and scaling an arc's radii", () => {
    const parts = fitParts(
      [
        { el: 'rect', ink: 'shape', x: 4, y: 8, width: 72, height: 40, rx: 4 },
        { el: 'circle', ink: 'solid', cx: 40, cy: 28, r: 4 },
        { el: 'path', ink: 'line', d: 'M4 8H76V48A36 20 0 0 1 4 48Z' },
      ],
      [4, 8, 76, 48],
      'stretch',
      box,
    );
    // 72 × 40 onto 200 × 100: x by 200/72, y by 2.5.
    expect(parts).toEqual([
      { el: 'rect', ink: 'shape', x: 10, y: 20, width: 200, height: 100, rx: 10 },
      { el: 'ellipse', ink: 'solid', cx: 110, cy: 70, rx: 10, ry: 10 },
      { el: 'path', ink: 'line', d: 'M10 20H210V120A100 50 0 0 1 10 120Z' },
    ]);
  });

  it('keeps proportions when told to contain, centred in the box', () => {
    expect(fitParts([{ el: 'rect', ink: 'shape', x: 0, y: 0, width: 10, height: 10 }], [0, 0, 10, 10], 'contain', box)).toEqual([
      { el: 'rect', ink: 'shape', x: 60, y: 20, width: 100, height: 100 },
    ]);
  });

  it('maps a polygon to a closed path', () => {
    expect(fitParts([{ el: 'polygon', ink: 'shape', points: '5,0 10,10 0,10' }], [0, 0, 10, 10], 'stretch', box)).toEqual([
      { el: 'path', ink: 'shape', d: 'M110 20L210 120L10 120Z' },
    ]);
  });

  it('refuses a relative path command rather than drawing it wrong', () => {
    expect(() => mapPath('m1 1l2 2', (x) => x, (y) => y, 1, 1)).toThrow('relative');
  });
});

describe('the shape catalogue (row CK)', () => {
  it('has the 43 shapes: 15 flowchart, 15 architecture and 13 UML, each named once', () => {
    const counts = SHAPE_GROUPS.map(({ id }) => SHAPE_TYPES.filter((type) => SHAPES[type].group === id).length);
    expect(counts).toEqual([15, 15, 13]);
    expect(new Set(SHAPE_TYPES.map((type) => SHAPES[type].name)).size).toBe(43);
  });

  it("draws today's four as before: the outline fills the box", () => {
    expect(SHAPES.rectangle.draw(box)).toEqual([{ el: 'rect', ink: 'shape', x: 10, y: 20, width: 200, height: 100 }]);
    expect(SHAPES.rounded.draw(box)).toEqual([{ el: 'rect', ink: 'shape', x: 10, y: 20, width: 200, height: 100, round: true }]);
    expect(SHAPES.ellipse.draw(box)).toEqual([{ el: 'ellipse', ink: 'shape', cx: 110, cy: 70, rx: 100, ry: 50 }]);
    expect(SHAPES.diamond.draw(box)).toEqual([{ el: 'path', ink: 'shape', d: 'M110 20L210 70L110 120L10 70Z' }]);
  });

  it('gives a database fixed-size caps, however tall it is drawn', () => {
    const [, short] = SHAPES.database.draw({ x: 0, y: 0, width: 160, height: 150 });
    const [, tall] = SHAPES.database.draw({ x: 0, y: 0, width: 160, height: 900 });
    expect(short).toMatchObject({ el: 'ellipse', ry: 16.5 });
    expect(tall).toMatchObject({ el: 'ellipse', ry: 20 });
  });

  it("never puts text on a solid part, which is the stroke's colour: a solid shape's name goes under it, on the board", () => {
    const area = { x: 0, y: 0, width: 200, height: 200 };
    const onSolid = SHAPE_TYPES.filter((type) => {
      const solid = SHAPES[type].draw(area).some(
        (part) => part.ink === 'solid' && (part.el === 'rect' ? part.width * part.height : part.el === 'ellipse' ? Math.PI * part.rx * part.ry : 0) > 0.05 * 200 * 200,
      );
      return solid && SHAPES[type].label.outside !== true;
    });
    expect(onSolid).toEqual([]);
    expect(['start', 'end', 'fork-join'].map((type) => SHAPES[type as 'start'].label.outside)).toEqual([true, true, true]);
  });

  it("names no shape a connector, the board's word for an arrow between objects", () => {
    expect(SHAPE_TYPES.map((type) => SHAPES[type].name).filter((name) => /connector/i.test(name))).toEqual([]);
    expect([SHAPES['circle-connector'].name, SHAPES['off-page'].name]).toEqual(['On-page reference', 'Off-page reference']);
  });
});

