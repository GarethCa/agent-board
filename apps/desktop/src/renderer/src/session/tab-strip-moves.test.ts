import { describe, expect, it } from 'vitest';
import type { TabDrag } from './shell-moves';
import { movesAlong } from './TabStrip';

describe('movesAlong', () => {
  const drag = { kind: 'shell' } as unknown as TabDrag;

  it('moves a tab along a strip that reorders, unless it drags as itself', () => {
    expect(movesAlong(true, undefined)).toBe(true);
    expect(movesAlong(true, drag)).toBe(false);
  });

  it('never moves a tab along a strip that does not reorder', () => {
    expect(movesAlong(false, undefined)).toBe(false);
    expect(movesAlong(false, drag)).toBe(false);
  });
});
