// Making room round the tiles expanded in place: what an expanded tile would cover is pushed clear of it for as
// long as it is expanded, and goes back when it collapses. View only: the board draws the moved positions, never saves
// them. Pure, so every case is unit-tested.
import type { Rect } from '../geometry';
import type { ExpandedTiles, OverlapsAllowed } from './expanded';
import { boundsOnBoard } from './items/items';
import { clearOf, PERCH_ROOM, TILE_GAP, ZONE_PADDING } from '@agent-board/daemon/board-layout';
import { CREW_PADDING } from './crews';
import { isSessionTile, isZone, type BoardNode } from './tiles';

/** Something an expanded tile may push: a tile, an item or a zone, by its id and where it is. */
export interface Movable {
  id: string;
  rect: Rect;
}

/**
 * Where moves may go, as in a zone: never left of `left` nor above `top` (the zone only grows right and down), and
 * inside `right` and `bottom` if there is room (a zone rearranges its tiles first and grows only when it must).
 */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type Direction = 'right' | 'down' | 'left' | 'up';

/** In this order on a tie, so the same layout always moves the same way. */
const DIRECTIONS: readonly Direction[] = ['right', 'down', 'left', 'up'];

/** Slack for positions worked out from fractional ones, px. */
const EPSILON = 1e-6;

/**
 * Where each of `movables` goes so that none is under, or within the gap of, the expanded rects `fixed`. Each one an
 * expanded rect covers is pushed out along its shortest axis, away from it, and pushes whatever it then lands on the
 * same way. Any push that would leave `bounds`, or come back under something, is put right by moving that one to the
 * clear spot nearest where it was. Only the movables that move are in the result, by id.
 */
export function clearOfExpanded(
  fixed: readonly Rect[],
  movables: readonly Movable[],
  bounds?: Bounds,
): Map<string, { x: number; y: number }> {
  // In reading order, then by id: the same layout, however it is listed, moves the same way.
  const order = movables.toSorted(inReadingOrder);
  const at = new Map(order.map((movable) => [movable.id, movable.rect]));
  const allowed = (rect: Rect) => withinHard(rect, bounds) && withinSoft(rect, bounds);
  let budget = 8 * order.length;

  const push = (id: string, from: Rect, direction: Direction): void => {
    if (budget-- <= 0) return;
    const next = { ...at.get(id)!, ...shoved(at.get(id)!, from, direction) };
    if (!allowed(next)) return;
    at.set(id, next);
    for (const other of order) {
      if (other.id !== id && !clearOf(at.get(other.id)!, [next])) push(other.id, next, direction);
    }
  };
  for (const rect of fixed) {
    for (const movable of order) {
      const now = at.get(movable.id)!;
      if (clearOf(now, [rect])) continue;
      const distance = (direction: Direction) => {
        const spot = shoved(now, rect, direction);
        return Math.abs(spot.x - now.x) + Math.abs(spot.y - now.y);
      };
      const direction = DIRECTIONS.filter((option) => allowed({ ...now, ...shoved(now, rect, option) })).toSorted(
        (a, b) => distance(a) - distance(b),
      )[0];
      if (direction !== undefined) push(movable.id, rect, direction);
    }
  }

  // Put right what the pushes left wrong: whatever stays put and is clear first, then the rest, each where it ended up
  // if that is clear, or else at the clear spot nearest where it was.
  const moved = (movable: Movable) => at.get(movable.id) !== movable.rect;
  const movedRects = order.filter(moved).map((movable) => at.get(movable.id)!);
  const stays = (movable: Movable) => !moved(movable) && clearOf(movable.rect, [...fixed, ...movedRects]);
  const accepted = [...fixed, ...order.filter(stays).map((movable) => movable.rect)];
  const result = new Map<string, { x: number; y: number }>();
  for (const movable of order) {
    if (stays(movable)) continue;
    const now = at.get(movable.id)!;
    const spot = clearOf(now, accepted) && withinHard(now, bounds) && (moved(movable) ? withinSoft(now, bounds) : true) ? now : nearestClear(movable.rect, accepted, bounds);
    accepted.push({ ...movable.rect, ...spot });
    if (spot.x !== movable.rect.x || spot.y !== movable.rect.y) result.set(movable.id, { x: spot.x, y: spot.y });
  }
  return result;
}

/** By top, then left, then id: so the same layout, however it is listed, moves the same way. */
const inReadingOrder = (a: Movable, b: Movable) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** What may overlap the node `id`, by id: the tile it was dropped onto, or that was dropped onto it. */
type Partner = (id: string) => readonly string[];

const noPartner: Partner = () => [];

/** Who each tile in `overlaps` may overlap: the tile it was dropped onto, and the other way round. */
function partnerOf(overlaps: OverlapsAllowed): Partner {
  if (overlaps.size === 0) return noPartner;
  const reverse = new Map([...overlaps].map(([dropped, onto]) => [onto, dropped]));
  return (id) => {
    const partner = overlaps.get(id) ?? reverse.get(id);
    return partner === undefined ? [] : [partner];
  };
}

/**
 * Where each of `rects` goes so that none is under, or within the gap of, another, but for a tile and its `partner`:
 * the `anchored` ones stay where they are, then each of the rest, in reading order, stays if it is clear of those
 * before it, or else goes to the clear spot nearest where it was, inside the hard `bounds` (and the soft ones if there
 * is room). Expanded tiles, and the zones grown round them, are kept apart so. Never by which is in front, so bringing
 * one forward moves nothing. Only the ones that move are in the result, by id.
 */
export function apart(
  rects: readonly Movable[],
  bounds?: Bounds,
  anchored: ReadonlySet<string> = new Set(),
  partner: Partner = noPartner,
): Map<string, { x: number; y: number }> {
  const order = rects.toSorted((a, b) => Number(anchored.has(b.id)) - Number(anchored.has(a.id)) || inReadingOrder(a, b));
  const accepted: Movable[] = [];
  const result = new Map<string, { x: number; y: number }>();
  for (const { id, rect } of order) {
    const others = accepted.filter((other) => !partner(id).includes(other.id)).map((other) => other.rect);
    const spot = anchored.has(id) || clearOf(rect, others) ? rect : nearestClear(rect, others, bounds);
    accepted.push({ id, rect: { ...rect, x: spot.x, y: spot.y } });
    if (spot.x !== rect.x || spot.y !== rect.y) result.set(id, { x: spot.x, y: spot.y });
  }
  return result;
}

/**
 * `clearOfExpanded`, but each movable whose `partner` is one of the `fixed` rects (it was dropped onto that one, or
 * that one onto it) is left free to overlap that one only: moved, after the others, clear of everything else.
 */
function clearOfFixed(fixed: readonly Movable[], movables: readonly Movable[], bounds: Bounds | undefined, partner: Partner) {
  const exempt = (movable: Movable) => fixed.some((rect) => partner(movable.id).includes(rect.id));
  const moves = clearOfExpanded(
    fixed.map((rect) => rect.rect),
    movables.filter((movable) => !exempt(movable)),
    bounds,
  );
  const placed = (movable: Movable): Rect => ({ ...movable.rect, ...moves.get(movable.id) });
  for (const movable of movables.filter(exempt).toSorted(inReadingOrder)) {
    const others = [
      ...fixed.filter((rect) => !partner(movable.id).includes(rect.id)).map((rect) => rect.rect),
      ...movables.filter((other) => other !== movable).map(placed),
    ];
    const own = clearOfExpanded(others, [movable], bounds).get(movable.id);
    if (own !== undefined) moves.set(movable.id, own);
  }
  return moves;
}

/** Where `rect` goes to be pushed `direction` until it is a gap clear of `from`. */
function shoved(rect: Rect, from: Rect, direction: Direction): { x: number; y: number } {
  switch (direction) {
    case 'right':
      return { x: from.x + from.width + TILE_GAP, y: rect.y };
    case 'left':
      return { x: from.x - TILE_GAP - rect.width, y: rect.y };
    case 'down':
      return { x: rect.x, y: from.y + from.height + TILE_GAP };
    case 'up':
      return { x: rect.x, y: from.y - TILE_GAP - rect.height };
  }
}

const withinHard = (rect: Rect, bounds: Bounds | undefined) =>
  bounds === undefined || (rect.x >= bounds.left - EPSILON && rect.y >= bounds.top - EPSILON);

const withinSoft = (rect: Rect, bounds: Bounds | undefined) =>
  bounds === undefined || (rect.x + rect.width <= bounds.right + EPSILON && rect.y + rect.height <= bounds.bottom + EPSILON);

/**
 * The spot nearest `rect` where it is a gap clear of `taken` and inside the hard `bounds`: inside the soft ones if any
 * such spot is. Tried straight across or straight up and down from it first, against the edges of what is taken;
 * within bounds, also any spot against those edges. Going right past everything is always clear (and, within bounds,
 * below everything too, for one hanging over their top or left), so there is one.
 */
function nearestClear(rect: Rect, taken: readonly Rect[], bounds: Bounds | undefined): { x: number; y: number } {
  const xs = [
    ...(bounds === undefined ? [] : [bounds.left, bounds.right - rect.width]),
    ...taken.flatMap((other) => [other.x - TILE_GAP - rect.width, other.x + other.width + TILE_GAP]),
  ];
  const ys = [
    ...(bounds === undefined ? [] : [bounds.top, bounds.bottom - rect.height]),
    ...taken.flatMap((other) => [other.y - TILE_GAP - rect.height, other.y + other.height + TILE_GAP]),
  ];
  const across = [...xs.map((x) => ({ x, y: rect.y })), ...ys.map((y) => ({ x: rect.x, y }))];
  const anywhere = bounds === undefined ? [] : xs.flatMap((x) => ys.map((y) => ({ x, y })));
  const fits = (spot: { x: number; y: number }) => withinHard({ ...rect, ...spot }, bounds) && clearOf({ ...rect, ...spot }, taken);
  const distance = (spot: { x: number; y: number }) => Math.hypot(spot.x - rect.x, spot.y - rect.y);
  const nearest = (spots: { x: number; y: number }[]) =>
    spots
      .filter(fits)
      .toSorted((a, b) => distance(a) - distance(b) || a.y - b.y || a.x - b.x)
      .at(0);
  const inside = (spots: { x: number; y: number }[]) => spots.filter((spot) => withinSoft({ ...rect, ...spot }, bounds));
  return nearest(inside(across)) ?? nearest(inside(anywhere)) ?? nearest([...across, ...anywhere])!;
}

/**
 * Where each node was drawn as the drag or resize under way began (`at`), with where its node was then (`from`), and a
 * grown zone's size then (`size`), by id: only the ones drawn otherwise than their node. While the change goes on, each
 * stays drawn there unless the change moves it, and a zone no smaller, so starting a drag or a resize moves nothing; the
 * ones the change runs into make way from there.
 */
export type Held = ReadonlyMap<string, { from: { x: number; y: number }; at: { x: number; y: number }; size?: { width: number; height: number } }>;

/** What `displaced` holds while a change is under way: where each of `nodes` is drawn in `shown`, and how big, if otherwise. */
export function heldFrom(nodes: readonly BoardNode[], shown: readonly BoardNode[]): Held {
  const drawn = new Map(shown.map((node) => [node.id, node]));
  const held = new Map<string, { from: { x: number; y: number }; at: { x: number; y: number }; size?: { width: number; height: number } }>();
  for (const node of nodes) {
    const was = drawn.get(node.id);
    if (was === undefined) continue;
    const moved = was.position.x !== node.position.x || was.position.y !== node.position.y;
    const grown = was.width !== node.width || was.height !== node.height;
    if (!moved && !grown) continue;
    held.set(node.id, { from: node.position, at: was.position, ...(grown && { size: { width: was.width ?? 0, height: was.height ?? 0 } }) });
  }
  return held;
}

/**
 * `nodes` as the board draws them with `expanded` open: the expanded tiles kept apart, and the tiles, items and zones an
 * expanded tile would cover moved clear of it. In a zone, its expanded tiles are kept apart, then its own tiles and
 * items are moved within it, the zone growing right and down only if they don't fit; then on the board the loose
 * expanded tiles and the zones they are in are kept apart, and whatever else is loose, zones too, is moved clear of them.
 * A tile in `overlaps` and the tile it was dropped onto are left free to overlap each other, and only each other.
 * While a drag or resize is under way, everything starts from where it was drawn as it began (`held`): what is resized,
 * or the zone it is in, keeps its place and the rest make way as it grows; what is dragged stays under the pointer and
 * moves nothing out of its way, so it can be dropped onto a tile (only its zone grows to hold it). A zone grown is marked `grown`. Nodes that don't move are the same objects; `nodes` is
 * unchanged.
 * Each of `crews` (the tiles of a crew frame, by node id) moves as one, its frame with it, by one shift that keeps its
 * layout, unless one of them is expanded, changing or dropped onto a tile (`overlaps`), when each moves on its own.
 */
export function displaced(
  nodes: BoardNode[],
  expanded: ExpandedTiles,
  overlaps: OverlapsAllowed = new Map(),
  held: Held = new Map(),
  crews: readonly (readonly string[])[] = [],
): BoardNode[] {
  if (expanded.length === 0) return nodes;
  const open = new Map(expanded.map((entry) => [entry.id, entry]));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const openNodes = nodes.filter((node) => open.has(node.id));
  if (openNodes.length === 0) return nodes;
  const partner = partnerOf(overlaps);
  const changing = (node: BoardNode) => node.dragging === true || node.resizing === true;
  const movable = (node: BoardNode) => !open.has(node.id) && !changing(node);
  const sizeOf = (node: BoardNode) => ({ width: node.width ?? node.measured?.width ?? 0, height: node.height ?? node.measured?.height ?? 0 });
  const positions = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string, { width: number; height: number }>();
  // Where each node was drawn as the change under way began, unless the change has moved it since.
  for (const node of nodes) {
    const was = held.get(node.id);
    if (was !== undefined && node.position.x === was.from.x && node.position.y === was.from.y) positions.set(node.id, was.at);
  }
  const at = (node: BoardNode) => positions.get(node.id) ?? node.position;
  // An expanded tile at its size, or at each step of a resize under way, so what it would cover moves as it is
  // dragged; a compact tile with the room above it for its subagents.
  const rectOf = (node: BoardNode): Rect => {
    const entry = open.get(node.id);
    if (entry !== undefined) return { ...at(node), ...(node.resizing === true ? sizeOf(node) : { width: entry.width, height: entry.height }) };
    const rect = { ...at(node), ...sizeOf(node) };
    return isSessionTile(node) ? perched(rect) : boundsOnBoard(node, rect);
  };
  /** The tiles of each block moved as one, by the id it moves by. */
  const blockTiles = new Map<string, readonly BoardNode[]>();
  const move = (moves: Map<string, { x: number; y: number }>, movables: readonly Movable[]) => {
    for (const { id, rect } of movables) {
      const spot = moves.get(id);
      if (spot === undefined) continue;
      for (const node of blockTiles.get(id) ?? [byId.get(id)!]) {
        const from = at(node);
        positions.set(node.id, { x: from.x + spot.x - rect.x, y: from.y + spot.y - rect.y });
      }
    }
  };
  /** Expanded tiles, with the room above them for their subagents, to keep apart: not one being dragged. */
  const toKeepApart = (open: readonly BoardNode[]) =>
    open.filter((node) => node.dragging !== true).map((node) => ({ id: node.id, rect: perched(rectOf(node)) }));

  // In each zone holding an expanded tile: its expanded tiles apart, then its own tiles and items, within it.
  const parents = [...new Set(openNodes.map((node) => node.parentId))].flatMap((id) => {
    const parent = id === undefined ? undefined : byId.get(id);
    return parent === undefined ? [] : [parent];
  });
  // Grown, as `withTiles` grows a zone, right and down to hold `rects` (relative to it).
  const holding = (size: { width: number; height: number }, rects: readonly Rect[]) => ({
    width: Math.max(size.width, ...rects.map((rect) => rect.x + rect.width + ZONE_PADDING)),
    height: Math.max(size.height, ...rects.map((rect) => rect.y + rect.height + TILE_GAP + ZONE_PADDING)),
  });
  for (const parent of parents) {
    const children = nodes.filter((node) => node.parentId === parent.id);
    const size = sizeOf(parent);
    const inside = { left: ZONE_PADDING, top: ZONE_PADDING, right: size.width - ZONE_PADDING, bottom: size.height - ZONE_PADDING };
    const openChildren = children.filter((node) => open.has(node.id));
    const resizing = new Set(openChildren.filter((node) => node.resizing === true).map((node) => node.id));
    const apartInZone = toKeepApart(openChildren);
    move(apart(apartInZone, inside, resizing, partner), apartInZone);
    // First grown to hold the expanded tiles themselves; then its own tiles and items rearranged in that, and grown
    // further only for what had to go past its edges.
    // One being dragged grows it, but moves nothing out of its way until it is dropped: it may be dropped onto a tile.
    const room = holding(size, openChildren.map(rectOf));
    const fixed = openChildren.filter((node) => node.dragging !== true).map((node) => ({ id: node.id, rect: rectOf(node) }));
    // A crew frame's tiles as one, the frame round them, unless one of them is expanded, changing or dropped onto a tile.
    const together = crews.flatMap((ids, index) => {
      const tiles = children.filter((node) => ids.includes(node.id));
      return tiles.length === ids.length && tiles.every((node) => movable(node) && partner(node.id).length === 0) ? [{ id: `\0block ${parent.id} ${index}`, tiles }] : [];
    });
    const inBlock = new Set(together.flatMap(({ tiles }) => tiles.map((node) => node.id)));
    for (const { id, tiles } of together) blockTiles.set(id, tiles);
    const movables = [
      ...children.filter((node) => movable(node) && !inBlock.has(node.id)).map((node) => ({ id: node.id, rect: rectOf(node) })),
      ...together.map(({ id, tiles }) => ({ id, rect: framed(tiles.map(rectOf)) })),
    ];
    const moves = clearOfFixed(fixed, movables, { ...inside, right: room.width - ZONE_PADDING, bottom: room.height - ZONE_PADDING }, partner);
    move(moves, movables);
    // No smaller than it was drawn as a change under way began: what is dragged out of it doesn't shrink it meanwhile.
    const was = parent.resizing === true ? undefined : held.get(parent.id)?.size;
    const moved = movables.filter(({ id }) => moves.has(id)).map(({ id, rect }) => ({ ...rect, ...moves.get(id)! }));
    const grown = holding(was === undefined ? room : { width: Math.max(room.width, was.width), height: Math.max(room.height, was.height) }, moved);
    if (grown.width !== size.width || grown.height !== size.height) sizes.set(parent.id, grown);
  }

  // On the board: the loose expanded tiles and the zones they are in apart, then everything else loose clear of them.
  // A zone changing, or with an expanded tile in it changing, keeps its place; the others make way.
  const zoneRect = (zone: BoardNode): Rect => ({ ...at(zone), ...(sizes.get(zone.id) ?? sizeOf(zone)) });
  const looseOpen = openNodes.filter((node) => node.parentId === undefined);
  const blocks = [...toKeepApart(looseOpen), ...parents.map((parent) => ({ id: parent.id, rect: zoneRect(parent) }))];
  const anchored = new Set([
    ...looseOpen.filter((node) => node.resizing === true).map((node) => node.id),
    ...parents.filter((parent) => changing(parent) || openNodes.some((node) => node.parentId === parent.id && changing(node))).map((parent) => parent.id),
  ]);
  // On the board, a loose tile dropped onto one in a zone may overlap that zone too, and the zone it.
  const zoneOf = (id: string) => byId.get(id)?.parentId;
  const onBoard: Partner = (id) => {
    const own = partner(id);
    if (own.length > 0) return [...own, ...own.flatMap((other) => (byId.get(id)?.parentId === undefined ? (zoneOf(other) ?? []) : []))];
    return nodes.filter((node) => node.parentId === undefined && partner(node.id).some((other) => zoneOf(other) === id)).map((node) => node.id);
  };
  move(apart(blocks, undefined, anchored, onBoard), blocks);
  const absolute = (node: BoardNode): Rect => {
    const parent = node.parentId === undefined ? undefined : byId.get(node.parentId);
    const rect = rectOf(node);
    return parent === undefined ? rect : { ...rect, x: rect.x + at(parent).x, y: rect.y + at(parent).y };
  };
  const fixed = [
    ...openNodes.filter((node) => node.dragging !== true).map((node) => ({ id: node.id, rect: absolute(node) })),
    ...parents.map((parent) => ({ id: parent.id, rect: zoneRect(parent) })),
  ];
  const loose = nodes
    .filter((node) => node.parentId === undefined && movable(node) && !parents.includes(node))
    .map((node) => ({ id: node.id, rect: rectOf(node) }));
  move(clearOfFixed(fixed, loose, undefined, onBoard), loose);

  const changed = (node: BoardNode) => {
    const position = positions.get(node.id);
    return position !== undefined && (position.x !== node.position.x || position.y !== node.position.y);
  };
  if (!nodes.some(changed) && sizes.size === 0) return nodes;
  return nodes.map((node) => {
    const position = changed(node) ? positions.get(node.id) : undefined;
    const size = sizes.get(node.id);
    if (position === undefined && size === undefined) return node;
    // A grown zone says so: its edges follow the expanded tile, so they are no snap target.
    const grown = size !== undefined && isZone(node) ? { data: { ...node.data, grown: true as const } } : {};
    return { ...node, ...(position && { position }), ...size, ...grown } as BoardNode;
  });
}

/** What a crew frame round `rects` (tiles with the room above them) takes: they and the frame's padding. */
function framed(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x)) - CREW_PADDING;
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width)) + CREW_PADDING;
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height)) + CREW_PADDING;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** `rect` with the room above it for a tile's subagents. */
const perched = (rect: Rect): Rect => ({ ...rect, y: rect.y - PERCH_ROOM, height: rect.height + PERCH_ROOM });

/**
 * The session tile that the session tile `id`, just dropped where it is in `nodes`, lies over, one of the two expanded:
 * dragged there, so the board lets the two overlap (`displaced`'s `overlaps`). Over several, an expanded one, then the
 * one it covers most, then the first by id. Undefined if it lies over none.
 */
export function droppedOnto(nodes: readonly BoardNode[], id: string, expanded: ExpandedTiles): string | undefined {
  const open = new Map(expanded.map((entry) => [entry.id, entry]));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rectOf = (node: BoardNode): Rect => {
    const parent = node.parentId === undefined ? undefined : byId.get(node.parentId);
    const entry = open.get(node.id);
    const size = entry ?? { width: node.width ?? node.measured?.width ?? 0, height: node.height ?? node.measured?.height ?? 0 };
    return { x: node.position.x + (parent?.position.x ?? 0), y: node.position.y + (parent?.position.y ?? 0), width: size.width, height: size.height };
  };
  const dropped = byId.get(id);
  if (dropped === undefined || !isSessionTile(dropped)) return undefined;
  const rect = rectOf(dropped);
  const under = nodes
    .filter((other) => other.id !== id && isSessionTile(other) && (open.has(id) || open.has(other.id)))
    .map((other) => ({ id: other.id, open: open.has(other.id), area: overlapArea(rect, rectOf(other)) }))
    .filter((other) => other.area > 0);
  return under.toSorted((a, b) => Number(b.open) - Number(a.open) || b.area - a.area || (a.id < b.id ? -1 : 1)).at(0)?.id;
}

/** How much of `a` and `b` is the same place. */
const overlapArea = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
