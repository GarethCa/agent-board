import { describe, expect, it } from 'vitest';
import { GLANCE_STATES, glanceFace } from './glance-tile';
import { PORTHOLE_TILES, WORKING_REVIEWER } from './PortholeTileGallery';

describe("the Porthole gallery's tiles", () => {
  it('show every glance state, each the one its shot is named for', () => {
    for (const state of GLANCE_STATES) {
      const { agent, implementer } = PORTHOLE_TILES[state];
      expect(glanceFace(agent, 'explicit', implementer).state, state).toBe(state);
    }
  });

  it('show a reviewer at work as Working, so only its mark says it reviews', () => {
    expect(WORKING_REVIEWER.agent.reviewOf).not.toBeNull();
    expect(glanceFace(WORKING_REVIEWER.agent, 'explicit', WORKING_REVIEWER.implementer).state).toBe('working');
  });
});
