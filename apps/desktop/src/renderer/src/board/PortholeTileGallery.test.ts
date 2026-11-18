import { describe, expect, it } from 'vitest';
import { MAX_STATUS_LENGTH } from '@agent-board/daemon/protocol';
import { GLANCE_STATES, glanceFace } from './glance-tile';
import { AT_THE_CAP, PORTHOLE_TILES, WORKING_REVIEWER } from './PortholeTileGallery';

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

  it('show a line as long as an agent can set', () => {
    expect(AT_THE_CAP).toHaveLength(MAX_STATUS_LENGTH);
  });

  it('ask to run a long command that still fits its box: four rows of mono, wrapped at its spaces, on a Porthole line', () => {
    const command = glanceFace(PORTHOLE_TILES.permission.agent, 'explicit', PORTHOLE_TILES.permission.implementer).line;
    expect(command).toMatch(/^Bash: rm -rf /);
    const text = command!.slice('Bash: '.length);
    expect(text.length).toBeGreaterThan(80);
    // At its smallest step, 11px, a mono character is 0.6em wide, so the 184px line holds 27 columns; one fewer leaves a margin.
    expect(wrappedRows(text, 26)).toBeLessThanOrEqual(4);
  });
});

// How many rows a line takes, wrapped at its spaces, `columns` characters to a row.
function wrappedRows(text: string, columns: number): number {
  let rows = 1;
  let row = 0;
  for (const word of text.split(' ')) {
    const width = row === 0 ? word.length : row + 1 + word.length;
    if (row > 0 && width > columns) {
      rows++;
      row = word.length;
    } else row = width;
  }
  return rows;
}
