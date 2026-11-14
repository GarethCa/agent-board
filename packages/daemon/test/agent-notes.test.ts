import { describe, expect, it } from 'vitest';
import { agentNoteSize } from '../src/agent-notes.ts';
import { AGENT_NOTE_SIZE, MAX_AGENT_NOTE_HEIGHT, MIN_AGENT_NOTE_SIZE } from '../src/protocol.ts';

describe('agentNoteSize', () => {
  it('starts a note tall enough for its lines, list items wrapping sooner: this one needs about 200 px', () => {
    const text = '**ENG-199 · round 2 of 3**\n\n- Implementer: fixing findings, `2 of 3` done\n- Reviewer: idle until `R2` arrives\n- Then the gate, and I merge **#185**';
    const { width, height } = agentNoteSize(text);
    expect(width).toBe(AGENT_NOTE_SIZE.width);
    expect(height).toBeGreaterThanOrEqual(160);
    expect(height).toBeLessThanOrEqual(220);
  });

  it('gives each of ten short lines a line of its own, with the tab and footer besides', () => {
    const text = Array.from({ length: 10 }, (_, index) => `Step ${index + 1} is done`).join('\n');
    expect(agentNoteSize(text).height).toBeGreaterThanOrEqual(70 + 10 * 17);
  });

  it('is taller the narrower it is: its lines wrap sooner', () => {
    const text = '- **impl**: fixing the review findings on the merge gate · PR #12 Notes fit their text';
    const wide = agentNoteSize(text);
    const narrow = agentNoteSize(text, 200);
    expect(narrow.width).toBe(200);
    expect(narrow.height).toBeGreaterThan(wide.height);
  });

  it('counts a CJK character or an emoji as two letters wide', () => {
    // The lines past the first, as the card's chrome and first line are the same for each.
    const more = (text: string) => agentNoteSize(text, 272, 0).height - agentNoteSize('a', 272, 0).height;
    expect(more('评'.repeat(120))).toBeGreaterThan(more('a'.repeat(120)) * 1.8);
    expect(more('🚀'.repeat(120))).toBeGreaterThan(more('a'.repeat(120)) * 1.8);
  });

  it('counts only what is drawn: no bold or italic marks, and a link as its text', () => {
    const plain = '- the review of the merge gate is done and the next round starts after lunch today';
    expect(agentNoteSize('- **the review** of the *merge gate* is done and the next round starts after lunch today', 256, 0)).toEqual(agentNoteSize(plain, 256, 0));
    expect(agentNoteSize('- the review of the [merge gate](https://example.com/a/very/long/address/that/is/not/drawn) is done and the next round starts after lunch today', 256, 0)).toEqual(
      agentNoteSize(plain, 256, 0),
    );
  });

  it('breaks a word too long for a line anywhere in it, as a long address is', () => {
    const address = `https://example.com/${'x'.repeat(150)}`;
    expect(agentNoteSize(address, 272, 0).height).toBeGreaterThan(agentNoteSize('x', 272, 0).height + 3 * 16);
  });

  it('keeps a short note at the least height, and a long one at most a screenful, scrolling past that', () => {
    expect(agentNoteSize('Done').height).toBe(AGENT_NOTE_SIZE.height);
    expect(agentNoteSize('word '.repeat(2000)).height).toBe(MAX_AGENT_NOTE_HEIGHT);
  });

  it("leaves room beside the bubble for the agent's face: the least a note is wide takes it in", () => {
    expect(MIN_AGENT_NOTE_SIZE.width).toBeGreaterThanOrEqual(200 + 38);
    // The text column is narrower by the face: the same text wraps as it would 38 px narrower without it.
    const text = '- **impl**: fixing the review findings on the merge gate · PR #12 Notes fit their text and more besides';
    expect(agentNoteSize(text, 272, 0).height).toBeGreaterThan(agentNoteSize(text, 310, 0).height);
  });
});

describe('agentNoteSize with a line budget', () => {
  const long = Array.from({ length: 12 }, (_, index) => `Step ${index + 1} is done`).join('\n');

  it('starts a note with a budget at the height of its lines, shorter than its whole text', () => {
    const whole = agentNoteSize(long, 272, 0).height;
    const three = agentNoteSize(long, 272, 0, 3).height;
    const six = agentNoteSize(long, 272, 0, 6).height;
    expect(three).toBeLessThan(whole);
    expect(six).toBeGreaterThan(three);
    // Each line more is a line's height more, whichever look draws it.
    expect(six - three).toBeGreaterThanOrEqual(3 * 16);
    expect(six - three).toBeLessThanOrEqual(3 * 17.5 + 1);
  });

  it('is the height of the whole text when the text is within its budget', () => {
    expect(agentNoteSize('Done\nShipped', 272, 0, 10)).toEqual(agentNoteSize('Done\nShipped', 272, 0));
  });

  it('starts no shorter than the least a note can be resized to, not the least a new note starts at', () => {
    expect(agentNoteSize(long, 272, AGENT_NOTE_SIZE.height, 1).height).toBe(MIN_AGENT_NOTE_SIZE.height);
  });

  it('keeps a budget past a screenful at most a screenful', () => {
    expect(agentNoteSize('word '.repeat(2000), 272, 0, 40).height).toBe(MAX_AGENT_NOTE_HEIGHT);
  });
});
