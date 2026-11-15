import { describe, expect, it } from 'vitest';
import { UNKNOWN_ITEM_NODE_TYPE } from '../items/items';
import { kindOf, selectionLabel } from './SelectionOverlays';

describe('the selection box label', () => {
  it('names each kind it counts', () => {
    expect(selectionLabel([kindOf('item:a', 'item:sticky')!, kindOf('item:b', 'item:sticky')!, kindOf('zone-1', 'zone')!])).toBe('3 selected · 2 notes, 1 zone');
  });

  it('counts an item of a kind this app does not know as an item', () => {
    expect(kindOf('item:a', UNKNOWN_ITEM_NODE_TYPE)).toBe('item');
    expect(selectionLabel([kindOf('item:a', UNKNOWN_ITEM_NODE_TYPE)!, kindOf('item:b', 'item:shape')!])).toBe('2 selected · 1 item, 1 shape');
  });
});
