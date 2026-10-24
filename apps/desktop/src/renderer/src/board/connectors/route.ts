// A line's way round the objects between its ends: a path of square turns through the gaps between them, kept clear
// of them by a margin. Elbow and curved lines with no bends of the user's take it; a straight line never does.
import type { ConnectorSide, ConnectorStyle, EdgePoint } from '@agent-board/daemon/protocol';
import type { Rect } from '../../geometry';
import { ROUTED_CORNER, roundedCorner, type LineEnds, type RoutePoint } from './geometry';

/** How far a routed line keeps from the objects it goes round. */
export const ROUTE_CLEARANCE = 16;
/**
 * The clearances a route tries, widest first: the whole, then half, which still fits down a gap the width of a whole
 * one, where the margins of the objects either side meet. Objects a tile gap apart (a note beside a tile) are that close.
 */
const CLEARANCES = [ROUTE_CLEARANCE, ROUTE_CLEARANCE / 2];
/** What a turn costs, as a length of line: enough that a route takes the gap with fewest turns, not the shortest. */
const TURN_COST = 40;
/** How much dearer a stretch is along the very edge of an object's margin than down the middle of a gap. */
const EDGE_HUGGING = 1.25;
/** The radii a routed curve tries at each corner, roundest first, until one keeps clear of the objects. */
const CORNER_RADII = [ROUTED_CORNER, 32, 24, 16, 8, 0];

/**
 * Whether a line goes round the objects in its way: an elbow or a curve, with no bends of the user's (a bend or a bow
 * puts it exactly where they dragged it), and not while one of its ends is being dragged.
 */
export const routes = (style: ConnectorStyle, points: readonly EdgePoint[], endDragged: boolean): boolean =>
  style !== 'straight' && points.length === 0 && !endDragged;

/** The objects a line's two ends are on, where it has them: they are in its way too, past where it leaves and arrives. */
export interface OwnObjects {
  source?: Rect;
  target?: Rect;
}

/** The way out of each side. */
const OUTWARD = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } } as const;
/** The four ways a route can go, as indexes into it: right, down, left, up. */
const WAYS: readonly EdgePoint[] = [OUTWARD.right, OUTWARD.bottom, OUTWARD.left, OUTWARD.top];
const wayOf = (direction: EdgePoint) => WAYS.findIndex((way) => way.x === direction.x && way.y === direction.y);

const grown = (rect: Rect, by: number): Rect => ({ x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by });
const meets = (a: Rect, b: Rect) => a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
const union = (a: Rect, b: Rect): Rect => {
  const [x, y] = [Math.min(a.x, b.x), Math.min(a.y, b.y)];
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};
const around = (points: readonly EdgePoint[]): Rect => points.map((point) => ({ ...point, width: 0, height: 0 })).reduce(union);
/** Whether `point` is inside `rect`, not on its outline. */
const within = (rect: Rect, point: EdgePoint) => point.x > rect.x && point.x < rect.x + rect.width && point.y > rect.y && point.y < rect.y + rect.height;

/** Whether the segment from `a` to `b` goes into `rect` (Liang–Barsky). */
function segmentEnters(a: EdgePoint, b: EdgePoint, rect: Rect): boolean {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  let [low, high] = [0, 1];
  const checks: [number, number][] = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.width - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.height - a.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) low = Math.max(low, t);
    else high = Math.min(high, t);
    if (low >= high) return false;
  }
  return true;
}

/** Whether the line through `samples` (a path's, from `samplePath`) goes into any of `rects`. */
export function crossesAny(samples: readonly EdgePoint[], rects: readonly Rect[]): boolean {
  for (let index = 1; index < samples.length; index++) {
    for (const rect of rects) if (segmentEnters(samples[index - 1]!, samples[index]!, rect)) return true;
  }
  return false;
}

/**
 * The way round for a line drawn as `samples` (its path unrouted, from `samplePath`) between these `ends`: through the
 * gaps (`routeAround`) when it crosses any of the `others`, the objects not at its ends, else undefined, and it is drawn
 * as it was.
 */
export function routeLine(ends: LineEnds, samples: readonly EdgePoint[], others: readonly Rect[], own: OwnObjects): RoutePoint[] | undefined {
  if (!crossesAny(samples, others)) return undefined;
  return routeAround(ends, others, own);
}

/**
 * The lanes along one axis, sorted, each once: along the `margins` of the objects in the way and through the `ends`, and
 * down the middle of every gap between two of those, so a route takes the middle of a gap. `margins` are the lanes
 * that hug an object.
 */
function lanesOf(margins: number[], ends: number[]): { lanes: number[]; margins: Set<number> } {
  const sorted = [...new Set([...margins, ...ends])].sort((a, b) => a - b);
  const lanes = sorted.flatMap((value, index) => (index === 0 ? [value] : [(sorted[index - 1]! + value) / 2, value]));
  return { lanes, margins: new Set(margins) };
}

/** The index of `value` in sorted `lanes`, which has it. */
function indexOf(lanes: readonly number[], value: number): number {
  let [low, high] = [0, lanes.length - 1];
  while (low < high) {
    const mid = (low + high) >> 1;
    if (lanes[mid]! < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The way a line with these `ends` goes round the `others` (the objects on the board not at its ends) and its `own`
 * two, as the points it goes through from its source to its target, each stretch square: out of its source's side and
 * into its target's, then through the gaps between the objects in the way, `ROUTE_CLEARANCE` from each, or half that
 * where the whole doesn't fit (`CLEARANCES`). Each corner says how far a curve may round it and keep that clear
 * (`radius`). Undefined when a straight line would do, or when nothing is clear even at half: an end hard against
 * another object, or boxed in.
 *
 * The board is cut into lanes along the margins round the objects near the line and the middles of the gaps between
 * them, and the route is the cheapest way along those lanes (A*), each turn costing extra.
 */
export function routeAround(ends: LineEnds, others: readonly Rect[], own: OwnObjects): RoutePoint[] | undefined {
  for (const clearance of CLEARANCES) {
    const route = routeWith(clearance, ends, others, own);
    // A straight line would do: a narrower clearance finds nothing more.
    if (route === 'straight') return undefined;
    if (route !== undefined) return route;
  }
  return undefined;
}

/** `routeAround`, keeping `clearance` from each object: `straight` when the way it finds is the straight line. */
function routeWith(clearance: number, ends: LineEnds, others: readonly Rect[], own: OwnObjects): RoutePoint[] | 'straight' | undefined {
  const obstacles = [...others, ...[own.source, own.target].filter((rect) => rect !== undefined)];
  const padded = obstacles.map((rect) => grown(rect, clearance));
  const sourceTile = own.source === undefined ? -1 : others.length;
  const targetTile = own.target === undefined ? -1 : obstacles.length - 1;
  // Each end sets out square from its side to the edge of its object's margin, which it may cross to get there.
  const start = setOutFrom(ends.source, ends.sourceSide, padded[sourceTile], clearance);
  const goal = setOutFrom(ends.target, ends.targetSide, padded[targetTile], clearance);
  if (padded.some((rect) => within(rect, start) || within(rect, goal))) return undefined;

  // Only the objects near the line: those in the box between its ends, and those touching them, and so on out.
  let region = grown(around([start, goal]), clearance);
  const near = new Set<number>();
  for (let grew = true; grew; ) {
    grew = false;
    padded.forEach((rect, index) => {
      if (near.has(index) || !(meets(rect, region) || index === sourceTile || index === targetTile)) return;
      near.add(index);
      region = union(region, grown(rect, clearance));
      grew = true;
    });
  }
  const blocks = [...near].map((index) => padded[index]!);
  const bounds = grown(region, clearance);

  const across = lanesOf(blocks.flatMap((rect) => [rect.x, rect.x + rect.width]), [bounds.x, bounds.x + bounds.width, start.x, goal.x]);
  const down = lanesOf(blocks.flatMap((rect) => [rect.y, rect.y + rect.height]), [bounds.y, bounds.y + bounds.height, start.y, goal.y]);
  const [xs, ys] = [across.lanes, down.lanes];
  const [columns, rows] = [xs.length, ys.length];

  // What is shut, marked a block at a time: the points inside a block, and the stretches between lanes inside one.
  const shut = new Uint8Array(columns * rows);
  const shutAcross = new Uint8Array(columns * rows);
  const shutDown = new Uint8Array(columns * rows);
  for (const rect of blocks) {
    const [left, right] = [indexOf(xs, rect.x), indexOf(xs, rect.x + rect.width)];
    const [top, bottom] = [indexOf(ys, rect.y), indexOf(ys, rect.y + rect.height)];
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        const cell = row * columns + column;
        const insideRow = row > top && row < bottom;
        const insideColumn = column > left && column < right;
        if (insideRow && insideColumn) shut[cell] = 1;
        // The stretch from this point to the next across, or down.
        if (insideRow && column < right) shutAcross[cell] = 1;
        if (insideColumn && row < bottom) shutDown[cell] = 1;
      }
    }
  }

  const from = indexOf(ys, start.y) * columns + indexOf(xs, start.x);
  const to = indexOf(ys, goal.y) * columns + indexOf(xs, goal.x);
  const setOut = wayOf(OUTWARD[ends.sourceSide]);
  const arrive = wayOf({ x: -OUTWARD[ends.targetSide].x, y: -OUTWARD[ends.targetSide].y });
  const path = cheapestWay({ xs, ys, shut, shutAcross, shutDown, xEdges: across.margins, yEdges: down.margins }, from, setOut, to, arrive);
  if (path === undefined) return undefined;
  const points = [ends.source, ...path.map((cell) => ({ x: xs[cell % columns]!, y: ys[Math.floor(cell / columns)]! })), ends.target];
  const route = withoutStraights(points);
  if (route.length <= 2) return 'straight';
  // A curve's corner keeps clear of the margins of the objects round it, and of its own two objects themselves: it
  // leaves and arrives inside their margins.
  const keepOut = [
    ...[...near].filter((index) => index !== sourceTile && index !== targetTile).map((index) => padded[index]!),
    ...[own.source, own.target].filter((rect) => rect !== undefined),
  ];
  return route.map((point, index) =>
    index === 0 || index === route.length - 1 ? point : { ...point, radius: cornerRadius(route[index - 1]!, point, route[index + 1]!, keepOut) },
  );
}

/** The roundest of `CORNER_RADII` a curve can round the corner `to` by, between `from` and `after`, out of all of `keepOut`. */
function cornerRadius(from: EdgePoint, to: EdgePoint, after: EdgePoint, keepOut: readonly Rect[]): number {
  return (
    CORNER_RADII.find((radius) => {
      const { enter, leave } = roundedCorner(from, to, after, radius);
      return [0.25, 0.5, 0.75].every((t) => {
        const u = 1 - t;
        const point = { x: u * u * enter.x + 2 * u * t * to.x + t * t * leave.x, y: u * u * enter.y + 2 * u * t * to.y + t * t * leave.y };
        return !keepOut.some((rect) => within(rect, point));
      });
    }) ?? 0
  );
}

/** Where a line leaving `point` out of `side` of its object reaches the edge of the object's `margin`, or `clearance` out from it. */
function setOutFrom(point: EdgePoint, side: ConnectorSide, margin: Rect | undefined, clearance: number): EdgePoint {
  if (margin === undefined) return { x: point.x + OUTWARD[side].x * clearance, y: point.y + OUTWARD[side].y * clearance };
  if (side === 'left') return { x: margin.x, y: point.y };
  if (side === 'right') return { x: margin.x + margin.width, y: point.y };
  if (side === 'top') return { x: point.x, y: margin.y };
  return { x: point.x, y: margin.y + margin.height };
}

interface Lanes {
  xs: readonly number[];
  ys: readonly number[];
  shut: Uint8Array;
  shutAcross: Uint8Array;
  shutDown: Uint8Array;
  /** The lanes along the edges of a margin, not down the middle of a gap. */
  xEdges: Set<number>;
  yEdges: Set<number>;
}

/**
 * The cheapest way along `lanes` from point `from`, setting out `setOut`, to point `to`, arriving going `arrive`: its
 * points in order, or undefined if there is none. Each state is a point and the way the route is going there.
 */
function cheapestWay(lanes: Lanes, from: number, setOut: number, to: number, arrive: number): number[] | undefined {
  const { xs, ys, shut, shutAcross, shutDown, xEdges, yEdges } = lanes;
  const columns = xs.length;
  const states = columns * ys.length * 4;
  const cost = new Float64Array(states).fill(Infinity);
  const came = new Int32Array(states).fill(-1);
  const goal = { x: xs[to % columns]!, y: ys[Math.floor(to / columns)]! };
  const guess = (cell: number) => Math.abs(xs[cell % columns]! - goal.x) + Math.abs(ys[Math.floor(cell / columns)]! - goal.y);
  const open = new Heap();
  const first = from * 4 + setOut;
  cost[first] = 0;
  open.push(first, guess(from));
  while (open.size > 0) {
    const state = open.pop();
    const [cell, way] = [state >> 2, state & 3];
    if (cell === to) return trace(came, state);
    const [column, row] = [cell % columns, Math.floor(cell / columns)];
    for (let next = 0; next < 4; next++) {
      // Never straight back the way it came.
      if (next === (way + 2) % 4) continue;
      const step = WAYS[next]!;
      const [nextColumn, nextRow] = [column + step.x, row + step.y];
      if (nextColumn < 0 || nextColumn >= columns || nextRow < 0 || nextRow >= ys.length) continue;
      const target = nextRow * columns + nextColumn;
      if (shut[target] === 1) continue;
      const stretch = step.x !== 0 ? shutAcross[row * columns + Math.min(column, nextColumn)] : shutDown[Math.min(row, nextRow) * columns + column];
      if (stretch === 1) continue;
      const length = step.x !== 0 ? Math.abs(xs[nextColumn]! - xs[column]!) : Math.abs(ys[nextRow]! - ys[row]!);
      const hugging = step.x !== 0 ? yEdges.has(ys[row]!) : xEdges.has(xs[column]!);
      // Arriving any way but `arrive`, it turns once more into the target's side.
      const turns = (next === way ? 0 : 1) + (target === to && next !== arrive ? 1 : 0);
      const total = cost[state]! + length * (hugging ? EDGE_HUGGING : 1) + turns * TURN_COST;
      const nextState = target * 4 + next;
      if (total >= cost[nextState]!) continue;
      cost[nextState] = total;
      came[nextState] = state;
      open.push(nextState, total + guess(target));
    }
  }
  return undefined;
}

/** The points of the way that ends at `state`, from its start. */
function trace(came: Int32Array, state: number): number[] {
  const cells: number[] = [];
  for (let at = state; at !== -1; at = came[at]!) {
    const cell = at >> 2;
    if (cells[0] !== cell) cells.unshift(cell);
  }
  return cells;
}

/** `points` without those part way along a straight stretch. */
function withoutStraights(points: readonly EdgePoint[]): EdgePoint[] {
  return points.filter((point, index) => {
    const [before, after] = [points[index - 1], points[index + 1]];
    if (before === undefined || after === undefined) return true;
    return !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  });
}

/** A binary min-heap of states by priority. */
class Heap {
  private readonly states: number[] = [];
  private readonly priorities: number[] = [];

  get size(): number {
    return this.states.length;
  }

  push(state: number, priority: number): void {
    const { states, priorities } = this;
    let at = states.length;
    states.push(state);
    priorities.push(priority);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (priorities[parent]! <= priority) break;
      states[at] = states[parent]!;
      priorities[at] = priorities[parent]!;
      at = parent;
    }
    states[at] = state;
    priorities[at] = priority;
  }

  pop(): number {
    const { states, priorities } = this;
    const top = states[0]!;
    const [state, priority] = [states.pop()!, priorities.pop()!];
    if (states.length > 0) {
      let at = 0;
      for (;;) {
        const left = at * 2 + 1;
        if (left >= states.length) break;
        const child = left + 1 < states.length && priorities[left + 1]! < priorities[left]! ? left + 1 : left;
        if (priorities[child]! >= priority) break;
        states[at] = states[child]!;
        priorities[at] = priorities[child]!;
        at = child;
      }
      states[at] = state;
      priorities[at] = priority;
    }
    return top;
  }
}
