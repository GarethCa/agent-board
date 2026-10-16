import { useCallback, useMemo, useRef, type RefObject } from 'react';
import type { NodeChange } from '@xyflow/react';
import type { ZoneLayout } from '@agent-board/daemon/protocol';
import type { Rect } from '../geometry';
import { isItemNode } from './items/items';
import { AGENT_TILE_SIZE, packTiles, PERCH_ROOM, TILE_GAP, ZONE_PADDING } from '@agent-board/daemon/board-layout';
import { holdsTiles, isSessionTile, isZone, layoutOf, sizeOfNode, type BoardNode } from './tiles';
import { isDefaultSize } from './tile-size';
import type { ZoneResize } from './ZoneNode';

/** How many halvings find how far a refused resize could have gone. */
const LIMIT_STEPS = 12;

type Places = Map<string, { x: number; y: number }>;

/** A zone being resized, in board coordinates. */
interface Resizing {
  id: string;
  /** The layout it last took. */
  last: ZoneLayout;
  /** Where its tiles are now, by node id. */
  tiles: Places;
  /** The sizes of its tiles that were resized, by node id. */
  sizes: Map<string, { width: number; height: number }>;
  /** Its notes, text and shapes, which tiles are packed round. */
  obstacles: Rect[];
}

interface ZoneResizeOptions {
  /** The board's nodes as last rendered. */
  nodesRef: RefObject<BoardNode[]>;
  setNodes(update: (nodes: BoardNode[]) => BoardNode[]): void;
  /** What handles node changes otherwise. */
  onNodesChange(changes: NodeChange<BoardNode>[]): void;
}

/**
 * Resizing zones: while a zone shrinks past its tiles, the tiles it cuts through are packed inward (`packTiles`)
 * as it goes, from where the last step left them, so a tile that still fits never moves and a moved one never jumps
 * back. A step that can't be packed is refused, and the zone's least size for this resize is set to how far it could
 * have gone, so the next step stops exactly there.
 */
export function useZoneResize({ nodesRef, setNodes, onNodesChange }: ZoneResizeOptions) {
  const resizing = useRef<Resizing>(undefined);

  const zoneResize = useMemo<ZoneResize>(
    () => ({
      start(id) {
        const zone = nodesRef.current.filter(isZone).find((node) => node.id === id);
        if (zone === undefined) return;
        const last = layoutOf(zone);
        const children = nodesRef.current.filter((node) => node.parentId === id);
        resizing.current = {
          id,
          last,
          tiles: new Map(children.filter(isSessionTile).map((node) => [node.id, { x: last.x + node.position.x, y: last.y + node.position.y }])),
          sizes: new Map(children.filter(isSessionTile).flatMap((node) => (node.data.expanded === true || isDefaultSize(sizeOfNode(node)) ? [] : [[node.id, sizeOfNode(node)] as const]))),
          obstacles: children.filter(isItemNode).map((node) => ({
            x: last.x + node.position.x,
            y: last.y + node.position.y,
            width: node.width ?? node.data.item.width,
            height: node.height ?? node.data.item.height,
          })),
        };
      },
      resize(id, next) {
        const state = resizing.current;
        if (state?.id !== id) return true;
        const packed = packAt(state, next);
        if (packed === undefined) {
          // The next step stops at how far this one could have gone.
          const resizeMin = limitOf(state, next);
          setNodes((current) => current.map((node) => (isZone(node) && node.id === id ? { ...node, data: { ...node.data, resizeMin } } : node)));
          return false;
        }
        state.tiles = packed;
        state.last = next;
        return true;
      },
    }),
    [nodesRef, setNodes],
  );

  /** Node changes, with the tiles of the zone being resized where they are packed. */
  const onResizeNodesChange = useCallback(
    (changes: NodeChange<BoardNode>[]) => {
      const state = resizing.current;
      if (state === undefined || !changes.some((change) => change.type === 'dimensions' && change.id === state.id)) {
        return onNodesChange(changes);
      }
      const { x, y } = state.last;
      onNodesChange([
        ...changes.filter((change) => change.type !== 'position' || !state.tiles.has(change.id)),
        ...[...state.tiles].map(([id, place]): NodeChange<BoardNode> => ({ id, type: 'position', position: { x: place.x - x, y: place.y - y } })),
      ]);
    },
    [onNodesChange],
  );

  /**
   * Ends the resize of zone `id` at `layout`: where its tiles were packed, in its terms, by node id, or undefined if it
   * wasn't being resized. Its least size goes back to what its tiles need.
   */
  const finish = useCallback(
    (id: string, layout: ZoneLayout): Places | undefined => {
      const state = resizing.current;
      if (state?.id !== id) return undefined;
      resizing.current = undefined;
      setNodes((current) =>
        current.map((node) => {
          if (!isZone(node) || node.id !== id || node.data.resizeMin === undefined) return node;
          return { ...node, data: { ...node.data, resizeMin: undefined } };
        }),
      );
      return new Map([...state.tiles].map(([nodeId, place]) => [nodeId, { x: place.x - layout.x, y: place.y - layout.y }]));
    },
    [setNodes],
  );

  return { zoneResize, onNodesChange: onResizeNodesChange, finish };
}

/** What a zone must cover to hold tiles at `places` (board coordinates) with its padding round them. */
function coversOf(places: readonly { x: number; y: number; width: number; height: number }[]) {
  return places.length === 0
    ? undefined
    : {
        left: Math.min(...places.map((place) => place.x)) - ZONE_PADDING,
        top: Math.min(...places.map((place) => place.y)) - ZONE_PADDING - PERCH_ROOM,
        right: Math.max(...places.map((place) => place.x + place.width)) + ZONE_PADDING,
        bottom: Math.max(...places.map((place) => place.y + place.height)) + TILE_GAP + ZONE_PADDING,
      };
}

/** Where `state`'s tiles go, on the board, with the zone at `next`; undefined if they can't be packed. */
function packAt(state: Resizing, next: ZoneLayout): Places | undefined {
  const tiles = [...state.tiles];
  // Still holding them where they are (one hanging over an edge stays put unless that edge comes in): nothing moves.
  const sizeOf = (id: string) => state.sizes.get(id) ?? AGENT_TILE_SIZE;
  if (holdsTiles(coversOf(tiles.map(([id, place]) => ({ ...place, ...sizeOf(id) }))), state.last, next)) return state.tiles;
  const packed = packTiles(
    next,
    tiles.map(([id, place]) => ({ id, x: place.x - next.x, y: place.y - next.y, ...state.sizes.get(id) })),
    state.obstacles.map((rect) => ({ ...rect, x: rect.x - next.x, y: rect.y - next.y })),
  );
  return packed && new Map([...packed].map(([id, place]) => [id, { x: place.x + next.x, y: place.y + next.y }]));
}

/** The least size the furthest `state` can go towards `next` gives the zone, along the axes that were shrinking. */
function limitOf(state: Resizing, next: ZoneLayout): { width?: number; height?: number } {
  const towards = (t: number): ZoneLayout => ({
    x: state.last.x + (next.x - state.last.x) * t,
    y: state.last.y + (next.y - state.last.y) * t,
    width: state.last.width + (next.width - state.last.width) * t,
    height: state.last.height + (next.height - state.last.height) * t,
  });
  let low = 0;
  let high = 1;
  for (let step = 0; step < LIMIT_STEPS; step++) {
    const middle = (low + high) / 2;
    if (packAt(state, towards(middle)) === undefined) high = middle;
    else low = middle;
  }
  const limit = towards(low);
  return {
    width: next.width < state.last.width ? Math.ceil(limit.width) : undefined,
    height: next.height < state.last.height ? Math.ceil(limit.height) : undefined,
  };
}
