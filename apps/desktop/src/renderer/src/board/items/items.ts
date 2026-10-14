import { createContext, useContext } from 'react';
import type { Node } from '@xyflow/react';
import type {
  BoardItem,
  BoardItemKind,
  ItemRemovedEvent,
  ItemUpdatedEvent,
  UpdateItemParams,
} from '@agent-board/daemon/protocol';
import { centreOf, contains, type Rect } from '../../geometry';

/** A change to an item, as the daemon announces it. */
export type ItemChange = ItemUpdatedEvent | ItemRemovedEvent;

export const ITEM_NODE_PREFIX = 'item:';

/** The React Flow node type of an item of `kind`: its kind under `item:`, apart from the board's own node types. */
export type ItemNodeTypeName = `${typeof ITEM_NODE_PREFIX}${BoardItemKind}`;
export const itemNodeType = (kind: BoardItemKind): ItemNodeTypeName => `${ITEM_NODE_PREFIX}${kind}`;

/**
 * A board item's node. `editing` opens it ready to type, as a note the user has just made is. Each kind has its own
 * node type, so its own node component.
 */
export type ItemNodeType = Node<{ item: BoardItem; editing?: boolean }, ItemNodeTypeName>;

/**
 * Items draw over zones (0) and tiles (1), except the kinds that frame things: a shape draws over its zone but under
 * the tiles. Among themselves they keep the order of the board's nodes: by `z`.
 */
const ITEM_Z_INDEX = 2;
const BELOW_TILES: readonly BoardItemKind[] = ['shape'];

export const isItemNode = (node: Node): node is ItemNodeType => node.id.startsWith(ITEM_NODE_PREFIX);

export function itemNode(item: BoardItem): ItemNodeType {
  return {
    id: `${ITEM_NODE_PREFIX}${item.id}`,
    type: itemNodeType(item.kind),
    ...(item.zoneId === null ? {} : { parentId: item.zoneId }),
    position: { x: item.x, y: item.y },
    width: item.width,
    height: item.height,
    data: { item },
    zIndex: BELOW_TILES.includes(item.kind) ? 0 : ITEM_Z_INDEX,
  };
}

/**
 * `nodes` with `item`'s node added, or updated, keeping what React Flow added to it (its selection, measurements). One
 * being dragged keeps its position: the drag's end saves it. An item in a zone the board doesn't have is left out, as
 * React Flow can't draw a child without its parent. Items stay in `z` order, the order they draw in.
 */
export function withItem<N extends Node>(nodes: N[], item: BoardItem): N[] {
  const id = `${ITEM_NODE_PREFIX}${item.id}`;
  const index = nodes.findIndex((node) => node.id === id);
  if (item.zoneId !== null && !nodes.some((node) => node.id === item.zoneId)) {
    return index < 0 ? nodes : nodes.toSpliced(index, 1);
  }
  const fresh = itemNode(item);
  if (index < 0) return inZOrder([...nodes, fresh as unknown as N]);
  const known = nodes[index]!;
  const node = {
    ...known,
    ...fresh,
    // Out of its zone, it must lose the one it had.
    parentId: fresh.parentId,
    position: known.dragging === true ? known.position : fresh.position,
    data: { ...known.data, item },
  };
  const updated = nodes.with(index, node as unknown as N);
  return (known as unknown as ItemNodeType).data.item.z === item.z ? updated : inZOrder(updated);
}

/**
 * `nodes` with the items sorted by `z` among the places items take, everything else where it was. Every item's place
 * comes after every zone's (new zones go first, items last), so a zone still comes before the items in it.
 */
function inZOrder<N extends Node>(nodes: N[]): N[] {
  const places: number[] = [];
  nodes.forEach((node, index) => {
    if (isItemNode(node)) places.push(index);
  });
  const z = (index: number) => (nodes[index] as unknown as ItemNodeType).data.item.z;
  const sorted = places.toSorted((a, b) => z(a) - z(b));
  if (sorted.every((from, at) => from === places[at])) return nodes;
  const out = [...nodes];
  sorted.forEach((from, at) => {
    out[places[at]!] = nodes[from]!;
  });
  return out;
}

/** `nodes` with `change` applied. */
export function withItemChange<N extends Node>(nodes: N[], change: ItemChange): N[] {
  return change.type === 'item.updated' ? withItem(nodes, change.item) : withoutItem(nodes, change.id);
}

export function withoutItem<N extends Node>(nodes: N[], id: string): N[] {
  return nodes.filter((node) => node.id !== `${ITEM_NODE_PREFIX}${id}`);
}

/**
 * Where an item with its top-left at board position `at` belongs: in the zone its centre is over (the one drawn on
 * top, later in `zones`, where they overlap), at a position relative to it; or on the board itself.
 */
export function placeOnBoard(
  at: { x: number; y: number },
  size: { width: number; height: number },
  zones: readonly (Rect & { id: string })[],
): { zoneId: string | null; x: number; y: number } {
  const centre = centreOf({ ...at, ...size });
  const zone = zones.findLast((z) => contains(z, centre));
  return zone === undefined ? { zoneId: null, ...at } : { zoneId: zone.id, x: at.x - zone.x, y: at.y - zone.y };
}

/** What an item's node can ask the board to do. */
export interface ItemActions {
  /**
   * Saves a change to the item, showing it at once. Changes with the same `coalesce` key made close together undo as
   * one, as the saves of one typing do.
   */
  update(params: UpdateItemParams, coalesce?: string): void;
  /**
   * Deletes the item, which can be undone. One `abandoned` as it was made, such as a text item left empty, takes its
   * making out of the undo history instead.
   */
  remove(id: string, options?: { abandoned?: boolean }): void;
  /** Opens a link from the item in the browser. */
  openLink(url: string): void;
}

/**
 * Whether several objects are selected: an item's own bar and resize handles then stay hidden, as the selection is
 * edited as one, from its context menu.
 */
export const SeveralSelectedContext = createContext(false);

/** Whether an item's own bar and resize handles show: it is selected, and on its own. */
export function useOnlySelected(selected: boolean | undefined): boolean {
  return selected === true && !useContext(SeveralSelectedContext);
}

export const ItemActionsContext = createContext<ItemActions>({
  update: () => {},
  remove: () => {},
  openLink: () => {},
});
