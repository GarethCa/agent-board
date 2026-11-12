import { describe, expect, it } from 'vitest';
import { historyPlace, layoutChoiceStep, nudgeMove, resizeMove, tileMoveStep, tileStepAction } from './hand-moves';

describe('the user moving a tile by hand', () => {
  it('counts a nudge as a move by hand', () => {
    expect(nudgeMove('z1', { x: 10, y: 20 })).toEqual({ zoneId: 'z1', x: 10, y: 20, byHand: true });
  });

  it('counts a resize that moved the tile as a move by hand, and one that did not as no move', () => {
    expect(resizeMove({ x: 0, y: 0 }, 'z1', { x: -40, y: 0 })).toEqual({ zoneId: 'z1', x: -40, y: 0, byHand: true });
    expect(resizeMove(null, null, { x: 5, y: 6 })).toEqual({ zoneId: null, x: 5, y: 6, byHand: true });
    expect(resizeMove({ x: 5, y: 6 }, 'z1', { x: 5, y: 6 })).toBeUndefined();
    expect(resizeMove({ x: 5, y: 6 }, 'z1', undefined)).toBeUndefined();
  });
});

describe('the history of a layout rule', () => {
  const places: [string, { zoneId: string; x: number; y: number; byHand?: boolean }][] = [
    ['agent:a', { zoneId: 'z1', x: 1, y: 2, byHand: true }],
    ['shell:b', { zoneId: 'z1', x: 3, y: 4 }],
  ];

  it('keeps a place without the mark of a drag still in flight', () => {
    expect(historyPlace({ zoneId: 'z1', x: 1, y: 2, byHand: true })).toEqual({ zoneId: 'z1', x: 1, y: 2 });
    const plain = { zoneId: null, x: 1, y: 2 };
    expect(historyPlace(plain)).toBe(plain);
  });

  it('records picking a rule as one step: the choice, and each tile put back where it was', () => {
    expect(layoutChoiceStep('z1', 'free', 'lanes', false, places)).toEqual([
      ['zone-layout-choice:z1', { type: 'zoneLayoutChoice', choice: 'free' }, { type: 'zoneLayoutChoice', choice: 'lanes' }],
      ['tile:agent:a', { type: 'tile', move: { zoneId: 'z1', x: 1, y: 2 } }, null],
      ['tile:shell:b', { type: 'tile', move: { zoneId: 'z1', x: 3, y: 4 } }, null],
    ]);
  });

  it('records leaving a rule too', () => {
    const step = layoutChoiceStep('z1', 'lanes', 'free', true, places);
    expect(step[0]).toEqual(['zone-layout-choice:z1', { type: 'zoneLayoutChoice', choice: 'lanes' }, { type: 'zoneLayoutChoice', choice: 'free' }]);
    expect(step).toHaveLength(3);
  });

  it('records nothing for a view picked over a view, or the same choice again', () => {
    expect(layoutChoiceStep('z1', 'shelves', 'clusters', false, places)).toEqual([]);
    expect(layoutChoiceStep('z1', 'lanes', 'lanes', true, places)).toEqual([]);
  });
});

describe('the history of a tile moved by hand', () => {
  const before = { zoneId: 'z1', x: 0, y: 0, byHand: true };

  it('records whether the tile was placed by hand before a move by hand', () => {
    const move = { zoneId: 'z1', x: 9, y: 9, byHand: true };
    expect(tileMoveStep('agent:a', before, move, undefined)).toEqual([
      'tile:agent:a',
      { type: 'tile', move: { zoneId: 'z1', x: 0, y: 0 }, handPlaced: false },
      { type: 'tile', move },
    ]);
    expect(tileMoveStep('agent:a', before, move, 'z1')[1]).toEqual({ type: 'tile', move: { zoneId: 'z1', x: 0, y: 0 }, handPlaced: true });
  });

  it('records no mark for a move not by hand', () => {
    expect(tileMoveStep('agent:a', before, { zoneId: 'z1', x: 9, y: 9 }, 'z1')[1]).toEqual({ type: 'tile', move: { zoneId: 'z1', x: 0, y: 0 } });
  });

  it('puts a tile that was not placed by hand back under its zone\'s rule', () => {
    expect(tileStepAction({ type: 'tile', move: { zoneId: 'z1', x: 0, y: 0 }, handPlaced: false }, 'z1')).toEqual({ kind: 'followRule', zoneId: 'z1' });
  });

  it('moves a tile that was placed by hand back by hand, so it is marked as it was', () => {
    expect(tileStepAction({ type: 'tile', move: { zoneId: 'z2', x: 0, y: 0 }, handPlaced: true }, 'z1')).toEqual({
      kind: 'move',
      move: { zoneId: 'z2', x: 0, y: 0, byHand: true },
    });
  });

  it('moves a tile back plainly otherwise', () => {
    const move = { zoneId: 'z2', x: 0, y: 0 };
    expect(tileStepAction({ type: 'tile', move, handPlaced: false }, 'z1')).toEqual({ kind: 'move', move });
    expect(tileStepAction({ type: 'tile', move }, undefined)).toEqual({ kind: 'move', move });
  });
});
