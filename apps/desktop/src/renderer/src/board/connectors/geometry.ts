// The path of a connector's or flow edge's line: straight, elbow or curved between its two ends, through any
// bends the user dragged into it, with where its label goes, where a new bend can be pulled out of it, and how long it is.
import { getBezierPath, getSmoothStepPath, getStraightPath, Position } from '@xyflow/react';
import type { ConnectorSide, ConnectorStyle, EdgePoint } from '@agent-board/daemon/protocol';

/** Where a line leaves and arrives: each end's point on its object, and the side of the object it is on. */
export interface LineEnds {
  source: EdgePoint;
  sourceSide: ConnectorSide;
  target: EdgePoint;
  targetSide: ConnectorSide;
}

export interface LineShape {
  /** The SVG path. */
  path: string;
  /** Where its label sits: halfway along it. */
  label: EdgePoint;
  /**
   * On each stretch between its ends and bends, in order, where a new bend can be pulled out: halfway along it, or as
   * near that as is clear of the label.
   */
  inserts: EdgePoint[];
  /** How long it is, on the board. */
  length: number;
  /**
   * The point a curve's bow goes through: the one point it was pulled to, else halfway along it (a curve bent through
   * several points before it had a bow, too).
   */
  bow: EdgePoint;
  /** Where its bow handle sits: on `bow`, or as near it along the line as is clear of the label. */
  bowHandle: EdgePoint;
}

const POSITIONS: Record<ConnectorSide, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };
/** The way out of each side. */
const OUTWARD: Record<ConnectorSide, EdgePoint> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
const isAcross = (side: ConnectorSide) => side === 'left' || side === 'right';

const at = (point: EdgePoint) => `${round(point.x)},${round(point.y)}`;
const round = (value: number) => Math.round(value * 1000) / 1000;

/** The size of what sits on a line's middle. */
export interface LabelSize {
  width: number;
  height: number;
}

/** How far along a stretch a place to pull out a bend is tried, in turn: halfway first, then out either way. */
const INSERT_SHARES = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.1, 0.9];
/** The room kept round a label, past its box, that a place to pull out a bend stays out of. */
const INSERT_CLEARANCE = 8;

/** Whether `point` is out of the `label` box centred on `at`, and the room kept round it. */
const clearOf = (point: EdgePoint, at: EdgePoint, label: LabelSize | undefined) =>
  label === undefined ||
  Math.abs(point.x - at.x) > label.width / 2 + INSERT_CLEARANCE ||
  Math.abs(point.y - at.y) > label.height / 2 + INSERT_CLEARANCE;

/** Along `samples` as near halfway as is out of the `label` box centred on `at`, or halfway if nowhere is. */
function insertOn(samples: readonly EdgePoint[], at: EdgePoint, label: LabelSize | undefined): EdgePoint {
  return INSERT_SHARES.map((share) => pointAlong(samples, share)).find((point) => clearOf(point, at, label)) ?? pointAlong(samples, 0.5);
}

/**
 * A curve's bow, and where its handle sits: on it, or along the line clear of the label on it. A curve kept with one
 * bend from before bows has its bow on that bend, which it passes through; one with several, halfway along it.
 */
function bowOf(samples: readonly EdgePoint[], points: readonly EdgePoint[], labelAt: EdgePoint, label: LabelSize | undefined) {
  const bow = points.length === 1 ? points[0]! : pointAlong(samples, 0.5);
  return { bow, bowHandle: clearOf(bow, labelAt, label) ? bow : insertOn(samples, labelAt, label) };
}

/**
 * React Flow's curve `path` (one cubic, `middle` halfway along it) bowed through `bow` (BU3): both its controls moved
 * by the same step, which moves its middle by three quarters of it, so it passes through `bow` there. A bow on its own
 * middle is the same curve, so grabbing the handle moves nothing; bowed, it leans out of its sides as it bows.
 */
function bowed(path: string, middle: EdgePoint, bow: EdgePoint): string {
  const [source, c1, c2, target] = (path.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number).reduce<EdgePoint[]>(
    (pairs, value, index) => (index % 2 === 0 ? [...pairs, { x: value, y: 0 }] : pairs.with(-1, { ...pairs.at(-1)!, y: value })),
    [],
  );
  const step = { x: ((bow.x - middle.x) * 4) / 3, y: ((bow.y - middle.y) * 4) / 3 };
  const moved = (control: EdgePoint) => ({ x: control.x + step.x, y: control.y + step.y });
  return `M${at(source!)} C${at(moved(c1!))} ${at(moved(c2!))} ${at(target!)}`;
}

/**
 * The line drawn in `style` from `ends.source` to `ends.target` through `points`. With no bends it is React Flow's own
 * path, so a line never bent draws exactly as it always has; a curve through one point is that path bowed through it
 * (`bowed`). `label` is the size of what sits halfway along it, if anything, kept clear of the places to pull out a
 * bend and of the bow handle.
 */
export function lineShape(style: ConnectorStyle, ends: LineEnds, points: readonly EdgePoint[], label?: LabelSize): LineShape {
  if (points.length === 0 || (style === 'curved' && points.length === 1 && points[0]!.bow === true)) {
    const flow = {
      sourceX: ends.source.x,
      sourceY: ends.source.y,
      targetX: ends.target.x,
      targetY: ends.target.y,
      sourcePosition: POSITIONS[ends.sourceSide],
      targetPosition: POSITIONS[ends.targetSide],
    };
    const [flowPath, labelX, labelY] =
      style === 'straight' ? getStraightPath(flow) : style === 'elbow' ? getSmoothStepPath({ ...flow, borderRadius: 0 }) : getBezierPath(flow);
    // React Flow's curve is halfway along itself, by its own measure, where it puts its label: its bow, unless bowed.
    const middle = { x: labelX, y: labelY };
    const bow = points[0] ?? middle;
    const path = points.length === 0 ? flowPath : bowed(flowPath, middle, bow);
    const samples = samplePath(path);
    // Its label is on its bow: its handle sits clear of it.
    const bowHandle = label === undefined ? bow : insertOn(samples, bow, label);
    return { path, label: bow, inserts: [insertOn(samples, bow, label)], length: lengthOf(samples), bow, bowHandle };
  }
  const stops = [ends.source, ...points, ends.target];
  const legs = style === 'elbow' ? elbowLegs(stops, ends) : stops.slice(1).map((_, index) => (style === 'straight' ? `L${at(stops[index + 1]!)}` : curveLeg(stops, index, ends)));
  const path = `M${at(ends.source)} ${legs.join(' ')}`;
  const samples = samplePath(path);
  const middle = pointAlong(samples, 0.5);
  const run = { length: lengthOf(samples), ...bowOf(samples, points, middle, label) };
  return {
    path,
    label: middle,
    inserts: legs.map((leg, index) => insertOn(samplePath(`M${at(stops[index]!)} ${leg}`), middle, label)),
    ...run,
  };
}

/** `point` moved `distance` along `direction`. */
const along = (point: EdgePoint, direction: EdgePoint, distance: number): EdgePoint => ({ x: point.x + direction.x * distance, y: point.y + direction.y * distance });

/** How far a curve's first and last stretches set out square from their sides. */
const CURVE_REACH = { least: 30, most: 90 };

/**
 * The curve from `stops[index]` to the next, as path commands without its move to its start: a Catmull-Rom curve
 * through the bends, whose first stretch sets out straight out of the source's side and whose last comes straight in
 * through the target's, however the bends lie.
 */
function curveLeg(stops: readonly EdgePoint[], index: number, ends: LineEnds): string {
  const from = stops[index]!;
  const to = stops[index + 1]!;
  // As far out of the side as React Flow's own curve goes for a stretch this long, within bounds: far enough to read as
  // leaving square, not so far it loops wide past a bend that lies to one side.
  const reach = Math.min(CURVE_REACH.most, Math.max(CURVE_REACH.least, Math.hypot(to.x - from.x, to.y - from.y) / 3));
  const before = stops[index - 1];
  const after = stops[index + 2];
  const c1 = before === undefined ? along(from, OUTWARD[ends.sourceSide], reach) : { x: from.x + (to.x - before.x) / 6, y: from.y + (to.y - before.y) / 6 };
  const c2 = after === undefined ? along(to, OUTWARD[ends.targetSide], reach) : { x: to.x - (after.x - from.x) / 6, y: to.y - (after.y - from.y) / 6 };
  return `C${at(c1)} ${at(c2)} ${at(to)}`;
}

/** How far an elbow goes straight out of its source's side, and straight into its target's, before it turns. */
const ELBOW_STUB = 20;

/**
 * The stretches of an elbow from `stops[0]` through each bend to the last, as path commands without their moves: each
 * a single corner. It leaves square out of the source's side, by a stub first, so a bend behind the source never takes
 * it back through its object; it goes on the way it was heading when the next bend is ahead, and turns first when it
 * isn't; and its last stretch comes into the target's side square, by a stub.
 */
function elbowLegs(stops: readonly EdgePoint[], ends: LineEnds): string[] {
  const into = OUTWARD[ends.targetSide];
  let heading = OUTWARD[ends.sourceSide];
  return stops.slice(1).map((to, index) => {
    const commands: EdgePoint[] = [];
    let from = stops[index]!;
    if (index === 0) {
      from = along(from, heading, ELBOW_STUB);
      commands.push(from);
    }
    const last = index === stops.length - 2;
    const arrive = last ? along(to, into, ELBOW_STUB) : to;
    // Its last stretch turns into the stub across the target's side, so the stub carries it square into the side.
    // Before that, it carries on the way it was heading when the next stop is ahead, and turns first when it isn't.
    const acrossFirst = last ? isAcross(ends.targetSide) : ahead(from, arrive, heading) === (heading.x !== 0);
    const corner = acrossFirst ? { x: arrive.x, y: from.y } : { x: from.x, y: arrive.y };
    commands.push(corner, arrive);
    if (last) commands.push(to);
    heading = directionOf(corner, arrive) ?? directionOf(from, corner) ?? heading;
    return commands.map((point) => `L${at(point)}`).join(' ');
  });
}

/** Whether `to` lies ahead of `from` along `heading`. */
const ahead = (from: EdgePoint, to: EdgePoint, heading: EdgePoint): boolean => (to.x - from.x) * heading.x + (to.y - from.y) * heading.y > 0;

/** The way from `from` to `to`, along one axis, or undefined if they are the same point. */
function directionOf(from: EdgePoint, to: EdgePoint): EdgePoint | undefined {
  const [dx, dy] = [to.x - from.x, to.y - from.y];
  if (dx === 0 && dy === 0) return undefined;
  return Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) };
}

/** How many points each curve is sampled at. */
const CURVE_STEPS = 16;

/**
 * Points along a path of absolute moves, lines, cubic and quadratic curves (what `lineShape` and React Flow draw),
 * each curve sampled finely enough to measure.
 */
export function samplePath(path: string): EdgePoint[] {
  const tokens = path.match(/[MLCQ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const samples: EdgePoint[] = [];
  let command = 'M';
  let index = 0;
  const next = (): EdgePoint => {
    const point = { x: Number(tokens[index]), y: Number(tokens[index + 1]) };
    index += 2;
    return point;
  };
  while (index < tokens.length) {
    if (/[MLCQ]/i.test(tokens[index]!)) command = tokens[index++]!.toUpperCase();
    const start = samples.at(-1) ?? { x: 0, y: 0 };
    if (command === 'M' || command === 'L') {
      const point = next();
      if (samples.length === 0 || point.x !== start.x || point.y !== start.y) samples.push(point);
    } else if (command === 'C') {
      const [c1, c2, end] = [next(), next(), next()];
      for (let step = 1; step <= CURVE_STEPS; step++) samples.push(cubic(start, c1, c2, end, step / CURVE_STEPS));
    } else {
      const [control, end] = [next(), next()];
      for (let step = 1; step <= CURVE_STEPS; step++) samples.push(quadratic(start, control, end, step / CURVE_STEPS));
    }
  }
  return samples;
}

function cubic(p0: EdgePoint, p1: EdgePoint, p2: EdgePoint, p3: EdgePoint, t: number): EdgePoint {
  const u = 1 - t;
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

function quadratic(p0: EdgePoint, p1: EdgePoint, p2: EdgePoint, t: number): EdgePoint {
  const u = 1 - t;
  const [a, b, c] = [u * u, 2 * u * t, t * t];
  return { x: a * p0.x + b * p1.x + c * p2.x, y: a * p0.y + b * p1.y + c * p2.y };
}

const lengthOf = (samples: readonly EdgePoint[]) =>
  samples.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - samples[index]!.x, point.y - samples[index]!.y), 0);

/** The point `share` (0 to 1) of the way along the polyline `samples`. */
export function pointAlong(samples: readonly EdgePoint[], share: number): EdgePoint {
  let left = lengthOf(samples) * share;
  for (let index = 1; index < samples.length; index++) {
    const [from, to] = [samples[index - 1]!, samples[index]!];
    const step = Math.hypot(to.x - from.x, to.y - from.y);
    if (step > 0 && left <= step) return { x: from.x + ((to.x - from.x) * left) / step, y: from.y + ((to.y - from.y) * left) / step };
    left -= step;
  }
  return samples.at(-1) ?? { x: 0, y: 0 };
}

/** Where bends are kept from: the middle of the line's two ends. */
const middleOf = ({ source, target }: Pick<LineEnds, 'source' | 'target'>): EdgePoint => ({ x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 });

/**
 * A line's bends on the board, from how they are kept: from the middle of its two ends, so a line whose objects move
 * together keeps its shape, and one whose end moves stretches with it.
 */
export const bendsOnBoard = (kept: readonly EdgePoint[], ends: Pick<LineEnds, 'source' | 'target'>): EdgePoint[] => {
  const middle = middleOf(ends);
  return kept.map((point) => ({ ...point, x: point.x + middle.x, y: point.y + middle.y }));
};

/** Bends on the board, as they are kept for a line with these ends. */
export const bendsFromBoard = (onBoard: readonly EdgePoint[], ends: Pick<LineEnds, 'source' | 'target'>): EdgePoint[] => {
  const middle = middleOf(ends);
  return onBoard.map((point) => ({ ...point, x: point.x - middle.x, y: point.y - middle.y }));
};

/** `points` with a new bend on stretch `leg` (0 from the source to the first bend), so it comes in order. */
export const withPointOn = (points: readonly EdgePoint[], leg: number, point: EdgePoint): EdgePoint[] => points.toSpliced(leg, 0, point);

/** `points` without the bend at `index`. */
export const withoutPoint = (points: readonly EdgePoint[], index: number): EdgePoint[] => points.toSpliced(index, 1);
