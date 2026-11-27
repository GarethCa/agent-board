import { describe, expect, it } from 'vitest';
import { boardPlace, expandedPlace, popUpPick, popUpPlace, tabHostOf } from './board-spotlight';
import type { BoardSubject } from './spotlight-results';

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

describe('⌘K in the pop-up', () => {
  it('opens the agent picked in the pop-up, in its place; picking its own agent only closes the switcher', () => {
    const place = popUpPlace('s-1');
    expect(place).toMatchObject({ context: { kind: 'popup', id: 's-1' }, mode: 'switch', current: 'agent:s-1' });
    expect(place.shiftOpens).toBeUndefined();
  });

  it('opens nothing beside the agent, and a pull request or page as from the board: the pop-up takes no tab from it', () => {
    expect(popUpPlace('s-1').opensBeside?.({ kind: 'session', target: { kind: 'agent', id: 's-2' } })).toBe(false);
    expect(tabHostOf({ kind: 'popup', id: 's-1' })).toBeUndefined();
  });

  it('pops up an agent picked; a shell, a zone, a pull request or a row of the Windows group is for the board', () => {
    const agent = { kind: 'agent', agent: { sessionId: 's-2' } } as BoardSubject;
    expect(popUpPick(agent, false)).toBe('s-2');
    // A Windows-group row brings its window back, as from the board.
    expect(popUpPick(agent, true)).toBeUndefined();
    expect(popUpPick({ kind: 'shell', shell: { id: 'sh-1' } } as BoardSubject, false)).toBeUndefined();
    expect(popUpPick({ kind: 'zone', zone: { id: 'z-1' } } as BoardSubject, false)).toBeUndefined();
    expect(popUpPick({ kind: 'pr' } as BoardSubject, false)).toBeUndefined();
  });
});

describe('⌘K on the board', () => {
  it('shows the tile picked, ⇧↵ opening its view; a pull request opens beside as the board says', () => {
    const opens = () => true;
    expect(boardPlace(opens)).toEqual({ context: { kind: 'board' }, mode: 'show', shiftOpens: true, opensBeside: opens });
  });
});
