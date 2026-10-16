import { describe, expect, it } from 'vitest';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { clampTileSize, keepTileSizes, TILE_MAX_SIZE, TILE_MIN_SIZE, tileSizeOf, tileSizesFrom, withTileSize } from './tile-size';

describe('clampTileSize', () => {
  it('snaps to the step and stays between the least and most', () => {
    expect(clampTileSize({ width: 301, height: 203 })).toEqual({ width: 304, height: 200 });
    expect(clampTileSize({ width: 10, height: 10 })).toEqual(TILE_MIN_SIZE);
    expect(clampTileSize({ width: 9999, height: 9999 })).toEqual(TILE_MAX_SIZE);
  });
});

describe('tile sizes', () => {
  it('give a tile never resized the default size', () => {
    expect(tileSizeOf({}, 'agent:a')).toEqual(AGENT_TILE_SIZE);
  });

  it('remember a resize, clamped, and forget it when it is reset to the default', () => {
    const resized = withTileSize({}, 'agent:a', { width: 400, height: 304 });
    expect(tileSizeOf(resized, 'agent:a')).toEqual({ width: 400, height: 304 });
    expect(withTileSize(resized, 'agent:a', undefined)).toEqual({});
    expect(withTileSize(resized, 'agent:a', AGENT_TILE_SIZE)).toEqual({});
  });

  it('are the same object when nothing changes', () => {
    const resized = withTileSize({}, 'agent:a', { width: 400, height: 304 });
    expect(withTileSize(resized, 'agent:a', { width: 400, height: 304 })).toBe(resized);
    expect(withTileSize(resized, 'agent:b', undefined)).toBe(resized);
  });

  it('keep only the tiles still on the board', () => {
    const sizes = withTileSize(withTileSize({}, 'agent:a', { width: 400, height: 304 }), 'agent:b', { width: 320, height: 200 });
    expect(Object.keys(keepTileSizes(sizes, new Set(['agent:b'])))).toEqual(['agent:b']);
    expect(keepTileSizes(sizes, new Set(['agent:a', 'agent:b']))).toBe(sizes);
  });

  it('are read from the view state, taking only well-formed ones', () => {
    const saved = { 'agent:a': { width: 400, height: 304 }, 'agent:b': { width: 'x', height: 1 }, 'agent:c': null, 'agent:d': { width: 5, height: 5 } };
    expect(tileSizesFrom(saved)).toEqual({ 'agent:a': { width: 400, height: 304 }, 'agent:d': TILE_MIN_SIZE });
    expect(tileSizesFrom(undefined)).toEqual({});
    expect(tileSizesFrom([1])).toEqual({});
  });
});
