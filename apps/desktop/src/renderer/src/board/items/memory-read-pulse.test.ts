import { describe, expect, it } from 'vitest';
import { readPulse } from './memory-read-pulse';

describe('a read pulse', () => {
  it('sets out from the middle of the memory and goes to the middle of its reader', () => {
    expect(readPulse(1, { x: 0, y: 0, width: 200, height: 100 }, { x: 400, y: 300, width: 100, height: 50 })).toEqual({ key: 1, x: 100, y: 50, dx: 350, dy: 275 });
  });

  it('is not drawn when the memory or the reader is not on this board', () => {
    expect(readPulse(1, undefined, { x: 0, y: 0, width: 1, height: 1 })).toBeUndefined();
    expect(readPulse(1, { x: 0, y: 0, width: 1, height: 1 }, undefined)).toBeUndefined();
  });
});
