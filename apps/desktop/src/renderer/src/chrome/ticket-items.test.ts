import { describe, expect, it } from 'vitest';
import type { BoardItem } from '@agent-board/daemon/protocol';
import { withListedTicketItems, withTicketItemChange } from './ticket-items';

const note = (id: string, ticket: string | null, text = 'a note') => ({ id, kind: 'sticky', ticket, zoneId: null, data: { text } }) as unknown as BoardItem;

describe('the items ⌘K finds on tickets’ boards', () => {
  it('keeps an item put on a ticket’s board, and its later edits', () => {
    const added = withTicketItemChange(new Map(), { type: 'item.updated', item: note('n1', 'chat') });
    const edited = withTicketItemChange(added, { type: 'item.updated', item: note('n1', 'chat', 'edited') });
    expect([...edited.values()]).toEqual([note('n1', 'chat', 'edited')]);
  });

  it('drops an item deleted, or moved off to the main board', () => {
    const known = new Map([['n1', note('n1', 'chat')], ['n2', note('n2', 'chat')]]);
    const removed = withTicketItemChange(known, { type: 'item.removed', id: 'n1', ticket: 'chat' });
    const moved = withTicketItemChange(removed, { type: 'item.updated', item: note('n2', null) });
    expect(moved.size).toBe(0);
  });

  it('leaves the items as they are for a change on the main board', () => {
    const known = new Map([['n1', note('n1', 'chat')]]);
    expect(withTicketItemChange(known, { type: 'item.updated', item: note('z1', null) })).toBe(known);
    expect(withTicketItemChange(known, { type: 'item.removed', id: 'z1', ticket: null })).toBe(known);
  });

  it('takes the tickets’ lists, but not over what a change has said since they were asked for', () => {
    // n1 was deleted and n2 edited while the lists were on their way; n3 is on a ticket that has gone.
    const known = new Map([['n2', note('n2', 'chat', 'edited')], ['n3', note('n3', 'gone')]]);
    const listed = [note('n1', 'chat'), note('n2', 'chat'), note('n4', 'chat')];
    const items = withListedTicketItems(known, listed, ['chat'], new Set(['n1', 'n2']));
    expect([...items.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual([note('n2', 'chat', 'edited'), note('n4', 'chat')]);
  });
});
