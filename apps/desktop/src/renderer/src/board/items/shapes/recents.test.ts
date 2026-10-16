import { beforeAll, describe, expect, it, vi } from 'vitest';
import { lastShape, parseRecents, recentShapes, noteShapeUsed, withRecent } from './recents';

describe('recent shapes', () => {
  beforeAll(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  });

  it('puts the shape used first, once, and keeps six', () => {
    expect(withRecent(['cloud', 'database'], 'database')).toEqual(['database', 'cloud']);
    expect(withRecent(['rectangle', 'rounded', 'ellipse', 'diamond', 'cloud', 'user'], 'actor')).toEqual([
      'actor',
      'rectangle',
      'rounded',
      'ellipse',
      'diamond',
      'cloud',
    ]);
  });

  it('reads back only shapes it knows, from what was stored', () => {
    expect(parseRecents('["cloud","hologram",3,"cloud","user"]')).toEqual(['cloud', 'user']);
    expect(parseRecents('not json')).toEqual([]);
    expect(parseRecents(null)).toEqual([]);
  });

  it('remembers the last shape used, which the Shape button draws, a rectangle before any', () => {
    expect(lastShape()).toBe('rectangle');
    noteShapeUsed('queue');
    noteShapeUsed('database');
    expect(lastShape()).toBe('database');
    expect(recentShapes()).toEqual(['database', 'queue']);
    expect(parseRecents(localStorage.getItem('agent-board.recent-shapes'))).toEqual(['database', 'queue']);
  });
});
