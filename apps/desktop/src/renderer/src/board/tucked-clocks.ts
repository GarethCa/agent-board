import { SPINE_MORE_CHIP_WIDTH } from '@agent-board/daemon/protocol';
import { cronWords } from '@agent-board/daemon/cron';
import { isItemNode, type ItemNodeType, type MoreClocks } from './items/items';
import type { BoardNode } from './tiles';

const isTucked = (node: BoardNode): node is ItemNodeType =>
  isItemNode(node) && node.data.item.kind === 'clock' && node.data.item.data.tucked === true && node.parentId !== undefined;

/**
 * `nodes` with the clocks a Spine zone set aside (the row along its top had no room for them) drawn as one "+N" chip per
 * zone: the first of them becomes the chip, where the zone put them all, and the others are hidden. The chip can't be
 * dragged, so it stays the zone's. The same array when no clock is set aside.
 */
export function withTuckedClocks(nodes: readonly BoardNode[]): BoardNode[] {
  const byZone = new Map<string, ItemNodeType[]>();
  for (const node of nodes) if (isTucked(node)) byZone.set(node.parentId!, [...(byZone.get(node.parentId!) ?? []), node]);
  if (byZone.size === 0) return [...nodes];
  const chips = new Map<string, MoreClocks>();
  for (const tucked of byZone.values()) {
    chips.set(tucked[0]!.id, { count: tucked.length, names: tucked.map((node) => cronWords(String(node.data.item.data.cron ?? ''))) });
  }
  return nodes.map((node): BoardNode => {
    if (!isTucked(node)) return node;
    const more = chips.get(node.id);
    if (more === undefined) return { ...node, hidden: true };
    return { ...node, width: SPINE_MORE_CHIP_WIDTH, draggable: false, data: { ...node.data, more } } as ItemNodeType;
  });
}
