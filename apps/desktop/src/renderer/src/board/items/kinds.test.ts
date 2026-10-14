import { describe, expect, it } from 'vitest';
import { BOARD_ITEM_KINDS } from '@agent-board/daemon/protocol';
import { ITEM_KINDS, ITEM_NODE_TYPES } from './kinds';

describe('the item kind registry', () => {
  it("names each kind's node type under item:, so a kind can't replace the board's own node types", () => {
    expect(Object.keys(ITEM_NODE_TYPES).sort()).toEqual(BOARD_ITEM_KINDS.map((kind) => `item:${kind}`).sort());
  });

  it("colours a sticky note on the minimap with the note's colour, as the theme draws it", () => {
    const note = { data: { text: '', color: '#a5d8ff' } };
    expect(ITEM_KINDS.sticky.minimapColor(note.data)).toBe('var(--sticky-blue)');
    expect(ITEM_KINDS.sticky.minimapColor({})).toBe('var(--sticky-yellow)');
    expect(ITEM_KINDS.sticky.minimapColor({ color: '#123456' })).toBe('#123456');
  });
});
