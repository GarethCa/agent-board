import { describe, expect, it } from 'vitest';
import { boardOrder, sessionNav, type NavSession } from './session-nav';

const at = (id: string, zoneId: string | null, x: number, y: number): NavSession => ({
  target: { kind: 'shell', id, title: id },
  zoneId,
  x,
  y,
});
const ids = (sessions: readonly NavSession[]) => sessions.map((session) => session.target.id);

describe('board order', () => {
  it('goes left to right along a row, then the rows top to bottom', () => {
    const sessions = [at('d', 'z', 20, 200), at('c', 'z', 380, 40), at('a', 'z', 20, 40), at('b', 'z', 200, 40)];
    expect(ids(boardOrder(sessions))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps tiles a little higher or lower than their neighbours in the same row', () => {
    const sessions = [at('b', 'z', 300, 30), at('a', 'z', 20, 60), at('c', 'z', 560, 45), at('d', 'z', 20, 220)];
    expect(ids(boardOrder(sessions))).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('moving between a group’s sessions', () => {
  const board = [
    at('planner', 'frontend', 20, 40),
    at('tokens', 'frontend', 300, 40),
    at('auth', 'frontend', 580, 40),
    at('nav', 'frontend', 20, 220),
    at('api', 'backend', 20, 40),
    at('spike', null, 900, 900),
    at('loose', null, 100, 900),
  ];

  it('counts where the session is among its zone’s, in board order', () => {
    const nav = sessionNav(board, 'auth')!;
    expect(nav).toMatchObject({ index: 2, count: 4, zoneId: 'frontend' });
    expect(nav.previous).toEqual({ target: board[1]!.target, wrapped: false });
    expect(nav.next).toEqual({ target: board[3]!.target, wrapped: false });
  });

  it('wraps at the ends, and says so', () => {
    expect(sessionNav(board, 'nav')!.next).toEqual({ target: board[0]!.target, wrapped: true });
    expect(sessionNav(board, 'planner')!.previous).toEqual({ target: board[3]!.target, wrapped: true });
  });

  it('steps a loose session through the board’s other loose sessions', () => {
    const nav = sessionNav(board, 'spike')!;
    expect(nav).toMatchObject({ index: 1, count: 2, zoneId: null });
    expect(nav.next.target.id).toBe('loose');
  });

  it('steps past sessions popped out into their own windows, and leaves them out of the count', () => {
    const nav = sessionNav(board, 'planner', new Set(['tokens', 'api']))!;
    expect(nav).toMatchObject({ index: 0, count: 3 });
    expect(nav.next.target.id).toBe('auth');
    expect(sessionNav(board, 'auth', new Set(['tokens']))!.previous.target.id).toBe('planner');
  });

  it('has nowhere to go for a session alone in its zone, and nothing for one not on the board', () => {
    const nav = sessionNav(board, 'api')!;
    expect(nav).toMatchObject({ index: 0, count: 1 });
    expect(nav.next.target.id).toBe('api');
    expect(sessionNav(board, 'gone')).toBeUndefined();
  });
});
