import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { EdgeLabelRenderer, Position, useInternalNode, useReactFlow, type EdgeProps, type InternalNode } from '@xyflow/react';
import type { ConnectorSide, ConnectorStyle, EdgePoint, FlowEdgeSide } from '@agent-board/daemon/protocol';
import { tokenNumber } from '../../theme';
import { bendsFromBoard, bendsOnBoard, lineShape, withoutPoint, withPointOn, type LabelSize, type LineEnds, type LineShape } from './geometry';
import { autoEnds } from './endpoints';
import { bowDragged, endDragged, endTarget, isDrag, letGo, type LineDraft, type LineGeometry } from './drag';
import { setNearNode, useFindNear } from './near';

export type { LineGeometry } from './drag';

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

/** What `useLine` is told to let an end be dragged to another object. */
export interface EndMoves {
  /** Whether its `which` end can be moved onto node `nodeId`: one of the objects a line of its kind can join. */
  canEndOn(nodeId: string, which: 'from' | 'to'): boolean;
  /** A double-click on its middle where there is nothing to straighten: what a double-click on the line does. */
  onDoubleClick?(): void;
  /**
   * An end was let go on another object: on the side `geometry` gives it, the line otherwise as `geometry` has it (the
   * other end's side as it was, `auto` too), its bends as kept.
   */
  onMoved(which: 'from' | 'to', nodeId: string, geometry: LineGeometry<FlowEdgeSide>): void;
}

type EdgeEnds = Pick<EdgeProps, 'source' | 'target' | 'sourceX' | 'sourceY' | 'targetX' | 'targetY' | 'sourcePosition' | 'targetPosition'>;

/**
 * The line of an edge as it is drawn now: where its handles put its ends, or, while an end is dragged to another side
 * or object, the middle of that side; its style; and its bends, as saved or as dragged. An `auto` end is on the middle
 * of the side of its tile facing the other tile. `handles` reshape it, shown while it is selected, clear of its `label`
 * (its size); `onReshape` gets what it was reshaped to, and `moves`, if given, lets an end go onto another object.
 * `ends` are where it meets its objects, and on which sides.
 */
export function useLine<Side extends FlowEdgeSide>(
  props: EdgeEnds,
  style: ConnectorStyle,
  saved: LineGeometry<Side>,
  onReshape: (geometry: LineGeometry<Side>) => void,
  label?: LabelSize,
  moves?: EndMoves,
) {
  const { getInternalNode } = useReactFlow();
  const sourceRect = rectOf(useInternalNode(props.source));
  const targetRect = rectOf(useInternalNode(props.target));
  const end = (x: number, y: number, position: Position, side: ConnectorSide, rect: Rect | undefined): EdgePoint =>
    SIDES[position] === side || rect === undefined ? attachment(x, y, position) : sideMiddle(rect, side);
  /** Where a line with ends on these sides meets its objects (`autoEnds`). */
  const endsOf = ({ fromSide, toSide }: Pick<LineGeometry<Side>, 'fromSide' | 'toSide'>): LineEnds => {
    const auto = autoEnds(fromSide, toSide, sourceRect, targetRect);
    return {
      source: auto.source ?? end(props.sourceX, props.sourceY, props.sourcePosition, auto.fromSide, sourceRect),
      sourceSide: auto.fromSide,
      target: auto.target ?? end(props.targetX, props.targetY, props.targetPosition, auto.toSide, targetRect),
      targetSide: auto.toSide,
    };
  };
  // Its bends on the board while it is drawn and dragged; kept from the middle of its ends (only these fields, whatever
  // else `saved` holds: a flow edge passes itself).
  const [draft, setDraft] = useState<LineDraft<Side>>();
  const geometry: LineDraft<Side> = draft ?? { fromSide: saved.fromSide, toSide: saved.toSide, points: bendsOnBoard(saved.points, endsOf(saved)) };
  const ends = withMovedEnd(endsOf(geometry), geometry, (nodeId) => rectOf(getInternalNode(nodeId)));
  const shape = lineShape(style, ends, geometry.points, label);
  const handles = (
    <LineHandles
      style={style}
      shape={shape}
      ends={ends}
      geometry={geometry}
      nodes={{ from: props.source, to: props.target }}
      rects={{ from: sourceRect, to: targetRect }}
      canEndOn={moves?.canEndOn}
      onLineDoubleClick={moves?.onDoubleClick}
      onDraft={setDraft}
      onDone={({ fromSide, toSide, points, moved }) => {
        setDraft(undefined);
        if (moved?.nodeId !== undefined) {
          // Its bends stay as they are kept, from the middle of its ends, wherever that now is.
          moves?.onMoved(moved.which, moved.nodeId, { fromSide, toSide, points: saved.points });
          return;
        }
        onReshape({ fromSide, toSide, points: bendsFromBoard(points, endsOf({ fromSide, toSide })) });
      }}
    />
  );
  return { shape, ends, handles };
}

/** `ends` with the end being dragged off its object where it is: on the side of the object it is over, or at the pointer. */
function withMovedEnd(ends: LineEnds, { moved, fromSide, toSide }: LineDraft<FlowEdgeSide>, rectOfNode: (nodeId: string) => Rect | undefined): LineEnds {
  if (moved === undefined) return ends;
  const side = (moved.which === 'from' ? fromSide : toSide) as ConnectorSide;
  const rect = moved.nodeId === undefined ? undefined : rectOfNode(moved.nodeId);
  const at = rect === undefined ? moved.at : sideMiddle(rect, side);
  if (at === undefined) return ends;
  return moved.which === 'from' ? { ...ends, source: at, sourceSide: side } : { ...ends, target: at, targetSide: side };
}

/** What a drag on one of a line's handles moves. */
type Grip = { kind: 'end'; which: 'from' | 'to' } | { kind: 'bend'; index: number } | { kind: 'insert'; leg: number } | { kind: 'bow' };

/**
 * The handles of a selected line: one on each end (BT1), dragged along its object's outline to another side, which
 * fixes that end there (an automatic one too), or onto another object it `canEndOn`, whose side nearest the pointer
 * lights and takes it; let go anywhere else, it goes back. A straight or elbow line has one on each bend, dragged to
 * move it, or double-clicked to take it out, and a smaller one halfway along each stretch, pulled out into a new
 * bend. A curve has one bow handle instead (BU3), on its middle, pulled sideways to bow the whole curve through it, and
 * double-clicked to straighten it again.
 */
function LineHandles<Side extends FlowEdgeSide>(props: {
  style: ConnectorStyle;
  shape: LineShape;
  ends: LineEnds;
  geometry: LineGeometry<Side>;
  /** The nodes at each end, and their rectangles. */
  nodes: Record<'from' | 'to', string>;
  rects: Record<'from' | 'to', Rect | undefined>;
  canEndOn?: EndMoves['canEndOn'];
  onLineDoubleClick?: () => void;
  onDraft(geometry: LineDraft<Side> | undefined): void;
  onDone(geometry: LineDraft<Side>): void;
}) {
  const { style, shape, ends, geometry, nodes, rects, canEndOn, onLineDoubleClick, onDraft, onDone } = props;
  const { screenToFlowPosition, getInternalNode } = useReactFlow();
  const findNear = useFindNear();
  /**
   * The drag under way: what it grabbed, the line and its bow as it began, and where it began on the screen and on the
   * board; `last`, once it has become a drag, the line as it has it now.
   */
  const drag = useRef<{ grip: Grip; started: LineGeometry<Side>; bow: EdgePoint; client: EdgePoint; from: EdgePoint; last?: LineDraft<Side> }>(undefined);

  const moved = ({ grip, started, bow, from }: NonNullable<typeof drag.current>, client: EdgePoint): LineDraft<Side> => {
    const at = screenToFlowPosition(client);
    if (grip.kind === 'end') {
      const { which } = grip;
      const other = which === 'from' ? nodes.to : nodes.from;
      const own = nodes[which];
      const can = canEndOn && ((nodeId: string) => canEndOn(nodeId, which));
      // Its handles lit are those of the object it lands on, if let go now: one hit-test for both.
      const near = can === undefined ? undefined : findNear(client, (nodeId) => nodeId === own || (nodeId !== other && can(nodeId)));
      const target = endTarget({ nodeId: own, rect: rects[which] }, near, can, (nodeId) => rectOf(getInternalNode(nodeId)));
      const draft = endDragged(started, which, at, target);
      const side = which === 'from' ? draft.fromSide : draft.toSide;
      setNearNode(target?.nodeId, target === undefined || side === 'auto' ? undefined : side);
      return draft;
    }
    if (grip.kind === 'bow') return bowDragged(started, bow, from, at);
    if (grip.kind === 'bend') return { ...started, points: started.points.with(grip.index, at) };
    return { ...started, points: withPointOn(started.points, grip.leg, at) };
  };

  const grab = (grip: Grip) => ({
    onPointerDown(event: ReactPointerEvent) {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const client = { x: event.clientX, y: event.clientY };
      drag.current = { grip, started: geometry, bow: shape.bow, client, from: screenToFlowPosition(client) };
    },
    onPointerMove(event: ReactPointerEvent) {
      const current = drag.current;
      const client = { x: event.clientX, y: event.clientY };
      // A press that has barely moved is still a click: it reshapes nothing.
      if (current === undefined || (current.last === undefined && !isDrag(current.client, client))) return;
      current.last = moved(current, client);
      onDraft(current.last);
    },
    onPointerUp(event: ReactPointerEvent) {
      const current = drag.current;
      drag.current = undefined;
      setNearNode(undefined);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (letGo(current?.last) === 'cancel') return onDraft(undefined);
      onDone(current!.last!);
    },
    onPointerCancel() {
      drag.current = undefined;
      setNearNode(undefined);
      onDraft(undefined);
    },
  });

  const place = (at: EdgePoint) => ({ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` });
  return (
    <EdgeLabelRenderer>
      {style === 'curved' ? (
        <div
          className="line-handle line-handle-bow nodrag nopan"
          data-testid="line-bow"
          title="Drag to bow the curve; double-click to straighten it"
          style={place(shape.bowHandle)}
          {...grab({ kind: 'bow' })}
          onDoubleClick={(event) => {
            event.stopPropagation();
            // A curve never bowed has nothing to straighten: the double-click is the line's, as it was before it had a
            // handle there (a connector's label is typed).
            if (geometry.points.length === 0) onLineDoubleClick?.();
            else onDone({ ...geometry, points: [] });
          }}
        />
      ) : (
        <>
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
        </>
      )}
      {(['from', 'to'] as const).map((which) => (
        <div
          key={which}
          className="line-handle line-handle-end nodrag nopan"
          data-testid="line-end"
          data-end={which}
          title={canEndOn === undefined ? 'Drag to another side' : 'Drag to another side, or onto another object'}
          style={place(which === 'from' ? ends.source : ends.target)}
          {...grab({ kind: 'end', which })}
        />
      ))}
    </EdgeLabelRenderer>
  );
}
