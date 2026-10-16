// What a drag on a selected line's handles does to it (BT1, BU3), apart from the pointer events that drive it.
import type { ConnectorSide, EdgePoint, FlowEdgeSide } from '@agent-board/daemon/protocol';
import type { Rect } from '../../geometry';
import { nearestSide } from './endpoints';

/**
 * What the user reshapes of a connector's or flow edge's line: the side of each end, and its bends, kept from the
 * middle of its two ends (see `bendsOnBoard`). A flow edge's side can be `auto`, picked as it is drawn, until the user
 * drags that end.
 */
export interface LineGeometry<Side extends FlowEdgeSide = ConnectorSide> {
  fromSide: Side;
  toSide: Side;
  points: EdgePoint[];
}

/**
 * A line's geometry while one of its handles is dragged, its bends on the board: with, while an end is dragged off its
 * object, where it is (`moved`): on another object it can end on (`nodeId`), or loose at the pointer (`at`).
 */
export type LineDraft<Side extends FlowEdgeSide> = LineGeometry<Side> & { moved?: { which: 'from' | 'to'; nodeId?: string; at?: EdgePoint } };

/** How far, on screen, a press must move before it drags a handle: less is a click, which reshapes nothing. */
const DRAG_SLOP = 3;

/** Whether a press at `from` that is now at `to`, both on screen, has become a drag. */
export const isDrag = (from: EdgePoint, to: EdgePoint): boolean => Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_SLOP;

/** The object a dragged end would land on, and whether it is the one the end is on now. */
export interface EndTarget {
  nodeId: string;
  rect: Rect;
  own: boolean;
}

/**
 * The object a dragged end is over: with no `canEndOn` (a line whose ends never leave their objects), always its own;
 * else the one found near the pointer (`near`, its own or one it can end on), or none.
 */
export function endTarget(
  own: { nodeId: string; rect: Rect | undefined },
  near: string | undefined,
  canEndOn: ((nodeId: string) => boolean) | undefined,
  rectOf: (nodeId: string) => Rect | undefined,
): EndTarget | undefined {
  if (canEndOn === undefined || near === own.nodeId) return own.rect === undefined ? undefined : { nodeId: own.nodeId, rect: own.rect, own: true };
  if (near === undefined || !canEndOn(near)) return undefined;
  const rect = rectOf(near);
  return rect === undefined ? undefined : { nodeId: near, rect, own: false };
}

/**
 * The line as its `which` end, dragged to board point `at`, has it: on `target`'s side nearest the pointer (its own
 * object's, a side change; another's, `moved` there), or, over nothing it can end on, loose at the pointer.
 */
export function endDragged<Side extends FlowEdgeSide>(started: LineGeometry<Side>, which: 'from' | 'to', at: EdgePoint, target: EndTarget | undefined): LineDraft<Side> {
  if (target === undefined) return { ...started, moved: { which, at } };
  // A side the user picks is one of every line's sides.
  const side = nearestSide(target.rect, at) as Side;
  const sides = which === 'from' ? { ...started, fromSide: side } : { ...started, toSide: side };
  return target.own ? sides : { ...sides, moved: { which, nodeId: target.nodeId } };
}

/**
 * The line with its bow dragged from board point `from` to `at`: bowed through where the bow was as the drag began
 * (`bow`) moved by as far as the pointer went, since its handle may sit off the bow, clear of a label.
 */
export const bowDragged = <Side extends FlowEdgeSide>(started: LineGeometry<Side>, bow: EdgePoint, from: EdgePoint, at: EdgePoint): LineDraft<Side> => ({
  ...started,
  points: [{ x: bow.x + at.x - from.x, y: bow.y + at.y - from.y, bow: true }],
});

/**
 * What letting go of a drag does: nothing for a press that never became a drag, or an end let go loose (an end always
 * joins something, so it goes back); moves an end let go on another object; else saves the reshape.
 */
export function letGo<Side extends FlowEdgeSide>(draft: LineDraft<Side> | undefined): 'cancel' | 'move' | 'reshape' {
  if (draft === undefined) return 'cancel';
  if (draft.moved === undefined) return 'reshape';
  return draft.moved.nodeId === undefined ? 'cancel' : 'move';
}
