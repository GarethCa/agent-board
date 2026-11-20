import { describe, expect, it } from 'vitest';
import { expandedPlace, tabHostOf } from './board-spotlight';

describe('⌘K in an expanded tile', () => {
  it('shows the tile picked on the board, and picking its own session only closes the switcher', () => {
    expect(expandedPlace('agent:s-1', 's-1')).toEqual({ context: { kind: 'expanded', nodeId: 'agent:s-1', id: 's-1' }, mode: 'show', current: 'agent:s-1' });
  });

  it('opens a pull request or page as a tab of the tile, never from the board, which would open its window over it', () => {
    expect(tabHostOf({ kind: 'expanded', nodeId: 'agent:s-1', id: 's-1' })).toBe('s-1');
    expect(tabHostOf({ kind: 'window', id: 's-2' })).toBe('s-2');
    expect(tabHostOf({ kind: 'board' })).toBeUndefined();
  });
});
