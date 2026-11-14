import { describe, expect, it } from 'vitest';
import type { Node, NodeChange } from '@xyflow/react';
import { rebasedReplaces } from './node-replace';

const card = (steps: string, extra: Partial<Node> = {}, data: Record<string, unknown> = {}): Node => ({
  id: 'item:card',
  position: { x: 10, y: 20 },
  height: 120,
  data: { item: { steps }, editing: true, ...data },
  ...extra,
});

const replace = (item: Node): NodeChange<Node> => ({ id: item.id, type: 'replace', item });

describe('rebasedReplaces', () => {
  it('lays a replace made from an older copy over the newer node, taking only what it changed', () => {
    const drawn = card('0/2');
    const now = card('1/2');
    const made = { ...drawn, height: 200, data: { ...drawn.data, editing: false } };

    const [change] = rebasedReplaces([replace(made)], new Map([[drawn.id, drawn]]), [now]);

    expect(change).toEqual(replace({ ...now, height: 200, data: { ...now.data, editing: false } }));
  });

  it('drops what the replace dropped, and keeps the newer node’s own changes', () => {
    const drawn = card('0/2', { className: 'lifted' }, { note: 'old' });
    const now = card('1/2', { className: 'lifted', selected: true }, { note: 'old' });
    const made: Node = { ...drawn, data: { ...drawn.data } };
    delete made.className;
    delete made.data.note;

    const [change] = rebasedReplaces([replace(made)], new Map([[drawn.id, drawn]]), [now]);

    expect(change).toEqual(replace({ id: now.id, position: now.position, height: 120, selected: true, data: { item: { steps: '1/2' }, editing: true } }));
  });

  it('takes a replace made from the node as the board holds it as it is', () => {
    const now = card('1/2');
    const made = { ...now, height: 200 };
    const changes = [replace(made)];

    expect(rebasedReplaces(changes, new Map([[now.id, now]]), [now])).toEqual(changes);
  });

  it('passes other changes, and a replace with no copy to go by, through', () => {
    const now = card('1/2');
    const changes: NodeChange<Node>[] = [{ id: now.id, type: 'select', selected: true }, replace(card('0/2', { height: 90 }))];

    expect(rebasedReplaces(changes, new Map(), [now])).toBe(changes);
  });
});
