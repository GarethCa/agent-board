import { describe, expect, it, vi } from 'vitest';
import type { MenuAction } from '../ui';
import { viewRows } from './ticket-parts';

describe("a ticket tile's view rows in its ⋯ menu", () => {
  const labels = (rows: ReturnType<typeof viewRows>) => rows.map((row) => (row as MenuAction).label);

  it('offers each view the tile is not in', () => {
    expect(labels(viewRows('terminal', vi.fn()))).toEqual(['Show as a card', 'Show as a board']);
    expect(labels(viewRows('card', vi.fn()))).toEqual(['Show as a terminal', 'Show as a board']);
    expect(labels(viewRows('board', vi.fn()))).toEqual(['Show as a card', 'Show as a terminal']);
  });

  it('switches the tile to the view its row names', () => {
    const onSwitch = vi.fn();
    (viewRows('card', onSwitch)[1] as MenuAction).onSelect();
    expect(onSwitch).toHaveBeenCalledWith('board');
  });
});
