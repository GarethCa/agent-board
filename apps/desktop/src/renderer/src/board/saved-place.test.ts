import { describe, expect, it } from 'vitest';
import { withSavedPlace } from './saved-place';

const tile = (zoneId: string | null, x: number, y: number, extra: { state?: string } = {}) => ({
  zoneId,
  position: { x, y, z: null },
  state: 'running',
  ...extra,
});

describe('withSavedPlace', () => {
  it('takes the place a move was saved at while the tile is still where it was when the move was asked for', () => {
    const before = tile('z1', 20, 44);
    expect(withSavedPlace(before, before, tile('z2', 300, 44))).toEqual(tile('z2', 300, 44));
  });

  it('takes it for a tile that had no place yet, which the board slotted in', () => {
    const unplaced = { zoneId: 'z1', position: null, state: 'running' };
    expect(withSavedPlace(unplaced, unplaced, tile('z1', 20, 44))).toEqual(tile('z1', 20, 44));
  });

  it('keeps a later move the board has heard of meanwhile, rather than going back to the one saved', () => {
    const asked = { zoneId: 'z1', position: null };
    const movedSince = tile('z1', 440, 300);
    expect(withSavedPlace(movedSince, asked, tile('z1', 20, 44))).toBe(movedSince);
  });

  it('takes only the place from the answer, never its other fields, which may be older than what the board has', () => {
    const before = tile('z1', 20, 44, { state: 'idle' });
    expect(withSavedPlace(before, tile('z1', 20, 44), tile('z1', 300, 44, { state: 'running' }))).toEqual(tile('z1', 300, 44, { state: 'idle' }));
  });
});
