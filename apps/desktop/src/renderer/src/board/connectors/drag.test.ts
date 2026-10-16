import { describe, expect, it } from 'vitest';
import { bowDragged, endDragged, endTarget, isDrag, letGo, type LineGeometry } from './drag';

const own = { x: 0, y: 0, width: 200, height: 100 };
const other = { x: 400, y: 0, width: 200, height: 100 };
const rects: Record<string, typeof own> = { own, other };
const rectOf = (nodeId: string) => rects[nodeId];
const line: LineGeometry<'top' | 'right' | 'bottom' | 'left' | 'auto'> = { fromSide: 'right', toSide: 'auto', points: [{ x: 10, y: 20 }] };

describe('an end being dragged', () => {
  const anything = () => true;

  it('moves round its own object to the side nearest the pointer', () => {
    const target = endTarget({ nodeId: 'own', rect: own }, 'own', anything, rectOf);
    expect(endDragged(line, 'from', { x: 100, y: 105 }, target)).toEqual({ ...line, fromSide: 'bottom' });
  });

  it('moves onto another object it can end on, to the side nearest the pointer, its bends as they were', () => {
    const target = endTarget({ nodeId: 'own', rect: own }, 'other', anything, rectOf);
    expect(endDragged(line, 'to', { x: 500, y: -4 }, target)).toEqual({ ...line, toSide: 'top', moved: { which: 'to', nodeId: 'other' } });
  });

  it('is loose at the pointer over nothing, or over an object it cannot end on', () => {
    const at = { x: 900, y: 900 };
    expect(endDragged(line, 'to', at, endTarget({ nodeId: 'own', rect: own }, undefined, anything, rectOf))).toEqual({ ...line, moved: { which: 'to', at } });
    expect(endTarget({ nodeId: 'own', rect: own }, 'other', () => false, rectOf)).toBeUndefined();
  });

  it('stays on its own object, however far it goes, on a line whose ends never leave theirs', () => {
    const target = endTarget({ nodeId: 'own', rect: own }, undefined, undefined, rectOf);
    expect(endDragged(line, 'from', { x: -500, y: 50 }, target)).toEqual({ ...line, fromSide: 'left' });
  });
});

describe('letting go of a drag', () => {
  it('reshapes nothing for a press that never became a drag, or an end let go loose: it goes back', () => {
    expect(letGo(undefined)).toBe('cancel');
    expect(letGo({ ...line, moved: { which: 'to', at: { x: 1, y: 1 } } })).toBe('cancel');
  });

  it('moves an end let go on another object, and saves any other reshape', () => {
    expect(letGo({ ...line, moved: { which: 'to', nodeId: 'other' } })).toBe('move');
    expect(letGo({ ...line, toSide: 'top' })).toBe('reshape');
  });

  it('counts a press as a drag only once it has moved a few pixels', () => {
    expect(isDrag({ x: 10, y: 10 }, { x: 11, y: 11 })).toBe(false);
    expect(isDrag({ x: 10, y: 10 }, { x: 13, y: 10 })).toBe(true);
  });
});

describe('a bow being dragged', () => {
  it('moves the bow by as far as the pointer went, wherever on its handle it was grabbed', () => {
    expect(bowDragged(line, { x: 150, y: 50 }, { x: 170, y: 40 }, { x: 170, y: 140 })).toEqual({ ...line, points: [{ x: 150, y: 150, bow: true }] });
  });
});
