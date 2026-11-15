import { describe, expect, it } from 'vitest';
import { CLOCK_SIZE, SPINE_MORE_CHIP_WIDTH, type BoardItem } from '@agent-board/daemon/protocol';
import { itemNode, type ItemNodeType } from './items/items';
import type { BoardNode } from './tiles';
import { withTuckedClocks } from './tucked-clocks';

const clock = (id: string, zoneId: string | null, data: Record<string, unknown> = {}): ItemNodeType =>
  itemNode({
    id,
    kind: 'clock',
    zoneId,
    ticket: null,
    x: 400,
    y: 28,
    ...CLOCK_SIZE,
    z: 1,
    rotation: 0,
    data: { cron: '0 9 * * 1-5', ...data },
    createdAt: '',
    updatedAt: '',
  } satisfies BoardItem);

const byId = (nodes: BoardNode[], id: string) => nodes.find((node) => node.id === `item:${id}`) as ItemNodeType;

describe('withTuckedClocks', () => {
  it('draws the clocks a zone set aside as one "+N" chip, the first of them, and hides the rest', () => {
    const nodes = withTuckedClocks([clock('shown', 'z1'), clock('a', 'z1', { tucked: true }), clock('b', 'z1', { tucked: true, cron: '0 * * * *' })]);
    const chip = byId(nodes, 'a');
    expect(chip.data.more).toEqual({ count: 2, names: [expect.any(String), expect.any(String)] });
    expect(chip.data.more!.names[0]).not.toBe(chip.data.more!.names[1]);
    expect(chip).toMatchObject({ width: SPINE_MORE_CHIP_WIDTH, draggable: false, position: { x: 400, y: 28 } });
    expect(chip.hidden).toBeUndefined();
    expect(byId(nodes, 'b').hidden).toBe(true);
    // A clock with room along the top is drawn as it is.
    expect(byId(nodes, 'shown')).toEqual(clock('shown', 'z1'));
  });

  it('gives each zone its own chip', () => {
    const nodes = withTuckedClocks([clock('a', 'z1', { tucked: true }), clock('b', 'z2', { tucked: true }), clock('c', 'z2', { tucked: true })]);
    expect(byId(nodes, 'a').data.more?.count).toBe(1);
    expect(byId(nodes, 'b').data.more?.count).toBe(2);
    expect(byId(nodes, 'c').hidden).toBe(true);
  });

  it('leaves every node as it is when no clock is set aside, or one is outside any zone', () => {
    const nodes = [clock('a', 'z1', { tucked: false }), clock('b', null, { tucked: true })];
    expect(withTuckedClocks(nodes)).toEqual(nodes);
  });
});
