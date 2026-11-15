import { describe, expect, it } from 'vitest';
import { BOARD_ITEM_KINDS } from '@agent-board/daemon/protocol';
import { itemKind, ITEM_KINDS, ITEM_NODE_TYPES } from './kinds';
import { UNKNOWN_ITEM_NODE_TYPE } from './items';
import { UnknownItemNode } from './UnknownItemNode';

describe('the item kind registry', () => {
  it("names each kind's node type under item:, so a kind can't replace the board's own node types", () => {
    expect(Object.keys(ITEM_NODE_TYPES).sort()).toEqual([...BOARD_ITEM_KINDS.map((kind) => `item:${kind}`), UNKNOWN_ITEM_NODE_TYPE].sort());
  });

  it("colours a sticky note on the minimap with the note's colour, as the theme draws it", () => {
    const note = { data: { text: '', color: '#a5d8ff' } };
    expect(ITEM_KINDS.sticky.minimapColor(note.data)).toBe('var(--sticky-blue)');
    expect(ITEM_KINDS.sticky.minimapColor({})).toBe('var(--sticky-yellow)');
    expect(ITEM_KINDS.sticky.minimapColor({ color: '#123456' })).toBe('#123456');
  });
});

describe('a kind this app does not know', () => {
  it('falls back to a placeholder that names the kind, has no colours, and is not typed into', () => {
    const kind = itemKind('mod');
    expect(kind.label).toBe('mod item');
    expect(kind.node).toBe(UnknownItemNode);
    expect(kind.colors).toBeUndefined();
    expect(kind.newData).toBeUndefined();
    expect(kind.editOnCreate).toBe(false);
    expect(kind.minimapColor({ anything: 1 })).toBe('var(--raised)');
  });

  it('keeps each known kind as it is', () => {
    for (const known of BOARD_ITEM_KINDS) expect(itemKind(known)).toBe(ITEM_KINDS[known]);
  });

  it('is drawn by its own node type, under item: as the kinds are', () => {
    expect(ITEM_NODE_TYPES[UNKNOWN_ITEM_NODE_TYPE]).toBe(UnknownItemNode);
  });
});
