import { describe, expect, it } from 'vitest';
import { GLANCE_STATES, glanceFace } from './glance-tile';
import { PORTHOLE_TILES } from './PortholeTileGallery';

describe("the Porthole gallery's tiles", () => {
  it('show every glance state, each the one its shot is named for', () => {
    for (const state of GLANCE_STATES) {
      const { agent, implementer } = PORTHOLE_TILES[state];
      expect(glanceFace(agent, 'explicit', implementer).state, state).toBe(state);
    }
  });
});
