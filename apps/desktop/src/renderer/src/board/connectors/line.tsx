import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { EdgeLabelRenderer, Position, useInternalNode, useReactFlow, type EdgeProps, type InternalNode } from '@xyflow/react';
import type { ConnectorSide, ConnectorStyle, EdgePoint } from '@agent-board/daemon/protocol';
import { tokenNumber } from '../../theme';
import { bendsFromBoard, bendsOnBoard, lineShape, withoutPoint, withPointOn, type LineEnds, type LineShape } from './geometry';
import { nearestSide } from './endpoints';

/**
 * What the user reshapes of a connector's or flow edge's line: the side of each end, and its bends, kept
 * from the middle of its two ends (see `bendsOnBoard`).
 */
export interface LineGeometry {
  fromSide: ConnectorSide;
  toSide: ConnectorSide;
  points: EdgePoint[];
}

const SIDES: Record<Position, ConnectorSide> = {
  [Position.Top]: 'top',
  [Position.Right]: 'right',
  [Position.Bottom]: 'bottom',
  [Position.Left]: 'left',
};

let insetCache: number | undefined;
/** How far a handle's outer edge is from its object's side: read once, since every line asks on every drag frame. */
function handleInset(): number {
  insetCache ??= tokenNumber('--connector-handle-size') / 2 + tokenNumber('--connector-handle-offset');
  return insetCache;
}

/** Where an end meets its object. React Flow ends a line at the outer edge of the handle, outside the object. */
function attachment(x: number, y: number, position: Position): EdgePoint {
  const inset = handleInset();
  if (position === Position.Left) return { x: x + inset, y };
  if (position === Position.Right) return { x: x - inset, y };
  if (position === Position.Top) return { x, y: y + inset };
  return { x, y: y - inset };
}

type Rect = { x: number; y: number; width: number; height: number };

const rectOf = (node: InternalNode | undefined): Rect | undefined =>
  node === undefined
    ? undefined
    : { ...node.internals.positionAbsolute, width: node.measured.width ?? node.width ?? 0, height: node.measured.height ?? node.height ?? 0 };

/** The middle of `side` of `rect`. */
function sideMiddle(rect: Rect, side: ConnectorSide): EdgePoint {
  if (side === 'top') return { x: rect.x + rect.width / 2, y: rect.y };
  if (side === 'bottom') return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
  if (side === 'left') return { x: rect.x, y: rect.y + rect.height / 2 };
  return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
}

type EdgeEnds = Pick<EdgeProps, 'source' | 'target' | 'sourceX' | 'sourceY' | 'targetX' | 'targetY' | 'sourcePosition' | 'targetPosition'>;

/**
 * The line of an edge as it is drawn now: where its handles put its ends, or, while an end is dragged to another side,
 * the middle of that side; its style; and its bends, as saved or as dragged. `handles` reshape it, shown while it is
 * selected, clear of its `label`; `onReshape` gets what it was reshaped to.
 */
export function useLine(
  props: EdgeEnds,
  style: ConnectorStyle,
  saved: LineGeometry,
  onReshape: (geometry: LineGeometry) => void,
  label?: Parameters<typeof lineShape>[3],
) {
  const sourceRect = rectOf(useInternalNode(props.source));
  const targetRect = rectOf(useInternalNode(props.target));
  const end = (x: number, y: number, position: Position, side: ConnectorSide, rect: Rect | undefined): EdgePoint =>
    SIDES[position] === side || rect === undefined ? attachment(x, y, position) : sideMiddle(rect, side);
  /** Where a line with ends on these sides meets its objects. */
  const endsOf = ({ fromSide, toSide }: Pick<LineGeometry, 'fromSide' | 'toSide'>): LineEnds => ({
    source: end(props.sourceX, props.sourceY, props.sourcePosition, fromSide, sourceRect),
    sourceSide: fromSide,
    target: end(props.targetX, props.targetY, props.targetPosition, toSide, targetRect),
    targetSide: toSide,
  });
  // Its bends on the board while it is drawn and dragged; kept from the middle of its ends (only these fields, whatever
  // else `saved` holds: a flow edge passes itself).
  const [draft, setDraft] = useState<LineGeometry>();
  const geometry = draft ?? { fromSide: saved.fromSide, toSide: saved.toSide, points: bendsOnBoard(saved.points, endsOf(saved)) };
  const ends = endsOf(geometry);
  const shape = lineShape(style, ends, geometry.points, label);
  const handles = (
    <LineHandles
      shape={shape}
      ends={ends}
      geometry={geometry}
      sourceRect={sourceRect}
      targetRect={targetRect}
      onDraft={setDraft}
      onDone={(next) => {
        setDraft(undefined);
        onReshape({ ...next, points: bendsFromBoard(next.points, endsOf(next)) });
      }}
    />
  );
  return { shape, handles };
}

/** What a drag on one of a line's handles moves. */
type Grip = { kind: 'end'; which: 'from' | 'to' } | { kind: 'bend'; index: number } | { kind: 'insert'; leg: number };

/**
 * The handles of a selected line: one on each end, dragged to another side of its object; one on each bend,
 * dragged to move it, or double-clicked to take it out; and a smaller one halfway along each stretch, pulled out into a
 * new bend.
 */
function LineHandles(props: {
  shape: LineShape;
  ends: LineEnds;
  geometry: LineGeometry;
  sourceRect: Rect | undefined;
  targetRect: Rect | undefined;
  onDraft(geometry: LineGeometry | undefined): void;
  onDone(geometry: LineGeometry): void;
}) {
  const { shape, ends, geometry, sourceRect, targetRect, onDraft, onDone } = props;
  const { screenToFlowPosition } = useReactFlow();
  const drag = useRef<{ grip: Grip; started: LineGeometry; last?: LineGeometry }>(undefined);

  const moved = (grip: Grip, started: LineGeometry, at: EdgePoint): LineGeometry => {
    if (grip.kind === 'end') {
      const rect = grip.which === 'from' ? sourceRect : targetRect;
      if (rect === undefined) return started;
      return grip.which === 'from' ? { ...started, fromSide: nearestSide(rect, at) } : { ...started, toSide: nearestSide(rect, at) };
    }
    if (grip.kind === 'bend') return { ...started, points: started.points.with(grip.index, at) };
    return { ...started, points: withPointOn(started.points, grip.leg, at) };
  };

  const grab = (grip: Grip) => ({
    onPointerDown(event: ReactPointerEvent) {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { grip, started: geometry };
    },
    onPointerMove(event: ReactPointerEvent) {
      const current = drag.current;
      if (current === undefined) return;
      current.last = moved(current.grip, current.started, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      onDraft(current.last);
    },
    onPointerUp(event: ReactPointerEvent) {
      const current = drag.current;
      drag.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (current?.last === undefined) return onDraft(undefined);
      onDone(current.last);
    },
    onPointerCancel() {
      drag.current = undefined;
      onDraft(undefined);
    },
  });

  const place = (at: EdgePoint) => ({ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` });
  return (
    <EdgeLabelRenderer>
      {shape.inserts.map((at, leg) => (
        <div
          key={`insert-${leg}`}
          className="line-handle line-handle-insert nodrag nopan"
          data-testid="line-insert"
          title="Drag to bend the line"
          style={place(at)}
          {...grab({ kind: 'insert', leg })}
        />
      ))}
      {geometry.points.map((at, index) => (
        <div
          key={`bend-${index}`}
          className="line-handle line-handle-bend nodrag nopan"
          data-testid="line-bend"
          title="Drag to move the bend; double-click to take it out"
          style={place(at)}
          {...grab({ kind: 'bend', index })}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onDone({ ...geometry, points: withoutPoint(geometry.points, index) });
          }}
        />
      ))}
      {(['from', 'to'] as const).map((which) => (
        <div
          key={which}
          className="line-handle line-handle-end nodrag nopan"
          data-testid="line-end"
          data-end={which}
          title="Drag to another side"
          style={place(which === 'from' ? ends.source : ends.target)}
          {...grab({ kind: 'end', which })}
        />
      ))}
    </EdgeLabelRenderer>
  );
}
