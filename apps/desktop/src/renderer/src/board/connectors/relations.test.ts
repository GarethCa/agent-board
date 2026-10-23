import { describe, expect, it } from 'vitest';
import { DEFAULT_CONNECTOR_LOOK } from '@agent-board/daemon/protocol';
import { RELATIONS, relationOf, swapped } from './relations';

describe('a connector’s relation', () => {
  it('sets each relation’s ends and dash, read back as that relation', () => {
    for (const relation of RELATIONS) expect(relationOf(relation.look), relation.id).toBe(relation.id);
    expect(Object.fromEntries(RELATIONS.map(({ id, look }) => [id, look]))).toEqual({
      association: { startEnd: 'none', endEnd: 'none', dashed: false },
      directed: { startEnd: 'none', endEnd: 'arrow', dashed: false },
      inheritance: { startEnd: 'none', endEnd: 'triangle', dashed: false },
      realisation: { startEnd: 'none', endEnd: 'triangle', dashed: true },
      dependency: { startEnd: 'none', endEnd: 'arrow', dashed: true },
      aggregation: { startEnd: 'diamond', endEnd: 'none', dashed: false },
      composition: { startEnd: 'filled-diamond', endEnd: 'none', dashed: false },
    });
  });

  it('reads a new connector as directed, and ends no relation has as none', () => {
    expect(relationOf(DEFAULT_CONNECTOR_LOOK)).toBe('directed');
    expect(relationOf({ startEnd: 'dot', endEnd: 'arrow', dashed: false })).toBeUndefined();
    expect(relationOf({ startEnd: 'none', endEnd: 'none', dashed: true })).toBeUndefined();
    // Drawn the other way, it is the same picture but not the relation as drawn: the menu offers to swap it.
    expect(relationOf({ startEnd: 'triangle', endEnd: 'none', dashed: false })).toBeUndefined();
  });
});

describe('swapping a connector’s direction', () => {
  it('joins its ends the other way round, each label staying by its object, its bends in the other order', () => {
    const connector: Parameters<typeof swapped>[0] = {
      from: { type: 'item', id: 'a', side: 'right' },
      to: { type: 'zone', id: 'z', side: 'top' },
      startLabel: '1',
      endLabel: '0..*',
      points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
    };

    expect(swapped(connector)).toEqual({
      from: connector.to,
      to: connector.from,
      startLabel: '0..*',
      endLabel: '1',
      points: [{ x: 3, y: 4 }, { x: 1, y: 2 }],
    });
  });
});
