import { describe, expect, it } from 'vitest';
import { agentNoteSize } from '../src/agent-notes.ts';
import { AGENT_NOTE_SIZE } from '../src/protocol.ts';

describe('agentNoteSize', () => {
  it('starts a note tall enough for its lines, list items wrapping sooner: this one needs about 200 px', () => {
    const text = '**ENG-199 · round 2 of 3**\n\n- Implementer: fixing findings, `2 of 3` done\n- Reviewer: idle until `R2` arrives\n- Then the gate, and I merge **#185**';
    const { width, height } = agentNoteSize(text);
    expect(width).toBe(AGENT_NOTE_SIZE.width);
    expect(height).toBeGreaterThanOrEqual(200);
    expect(height).toBeLessThanOrEqual(250);
  });

  it('keeps a short note at the least height, and a long one at most a screenful, scrolling past that', () => {
    expect(agentNoteSize('Done').height).toBe(AGENT_NOTE_SIZE.height);
    expect(agentNoteSize('word '.repeat(2000)).height).toBe(480);
  });
});
