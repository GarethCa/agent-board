import type { Edge } from '@xyflow/react';
import type { Connector, ConnectorEnd, ConnectorEndType, ConnectorSide, EdgePoint, FlowEdgeShape, FlowEdgeSide, UpdateConnectorParams } from '@agent-board/daemon/protocol';
import type { ConnectorChange } from '../../../../preload/api';
import { ITEM_NODE_PREFIX } from '../items/items';
import { AGENT_NODE_PREFIX, EXTERNAL_NODE_PREFIX, SHELL_NODE_PREFIX } from '../tiles';
import type { Rect } from '../../geometry';

/** The React Flow edge type of a connector, apart from the flow edges (M2) the board will draw. */
const CONNECTOR_EDGE_TYPE = 'connector';
export const CONNECTOR_EDGE_PREFIX = 'connector:';

/** Above every node but a tile being dragged, so a line is never hidden behind what it joins. */
const CONNECTOR_Z_INDEX = 3;

/** The node id prefix of each kind of object. A zone's node is its own id. */
const NODE_PREFIXES: Record<ConnectorEndType, string> = {
  zone: '',
  item: ITEM_NODE_PREFIX,
  agent: AGENT_NODE_PREFIX,
  shell: SHELL_NODE_PREFIX,
  external: EXTERNAL_NODE_PREFIX,
};

/** The board node a connector's end is fixed to. */
export const nodeIdOf = (end: Pick<ConnectorEnd, 'type' | 'id'>): string => `${NODE_PREFIXES[end.type]}${end.id}`;

/**
 * The connector end for a board node, or undefined for a node a connector can't join. `node.type` tells a zone from the rest.
 */
export function endOfNode(node: { id: string; type?: string }, side: ConnectorSide): ConnectorEnd | undefined {
  if (node.type === 'zone') return { type: 'zone', id: node.id, side };
  for (const type of ['item', 'agent', 'shell', 'external'] as const) {
    const prefix = NODE_PREFIXES[type];
    if (node.id.startsWith(prefix)) return { type, id: node.id.slice(prefix.length), side };
  }
  return undefined;
}

/** The edge that draws `connector`. */
function connectorEdge(connector: Connector, selected: boolean): Edge<{ connector: Connector }> {
  return {
    id: `${CONNECTOR_EDGE_PREFIX}${connector.id}`,
    type: CONNECTOR_EDGE_TYPE,
    source: nodeIdOf(connector.from),
    sourceHandle: connector.from.side,
    target: nodeIdOf(connector.to),
    targetHandle: connector.to.side,
    selected,
    zIndex: CONNECTOR_Z_INDEX,
    data: { connector },
  };
}

export const isConnectorEdge = (edge: Edge): boolean => edge.id.startsWith(CONNECTOR_EDGE_PREFIX);
export const connectorIdOf = (edge: Edge): string => edge.id.slice(CONNECTOR_EDGE_PREFIX.length);

/**
 * The edges for `connectors`, leaving out any whose object isn't on the board (`nodeIds`): one deleted, or in a zone
 * the board doesn't have yet. The daemon deletes those connectors itself, and tells nobody.
 */
export function connectorEdges(
  connectors: readonly Connector[],
  nodeIds: ReadonlySet<string>,
  selected: ReadonlySet<string>,
): Edge[] {
  return connectors
    .filter((c) => nodeIds.has(nodeIdOf(c.from)) && nodeIds.has(nodeIdOf(c.to)))
    .map((c) => connectorEdge(c, selected.has(c.id)));
}

/** `connectors` with `connector` added, or replacing the one with its id. */
export function withConnector(connectors: readonly Connector[], connector: Connector): Connector[] {
  const index = connectors.findIndex((known) => known.id === connector.id);
  return index < 0 ? [...connectors, connector] : connectors.with(index, connector);
}

/**
 * How `connector` is drawn: the sides of its objects it joins, its style and its bends, as a flow edge has
 * them, its sides always ones the user picked.
 */
export const shapeOf = (connector: Connector): FlowEdgeShape & { fromSide: ConnectorSide; toSide: ConnectorSide } => ({
  fromSide: connector.from.side,
  toSide: connector.to.side,
  style: connector.style,
  points: connector.points,
});

/** `connector` as `params` change it: its look, label or bends, the side of an end, or an end moved onto another object. */
export function withConnectorParams(connector: Connector, params: UpdateConnectorParams): Connector {
  const { fromSide, toSide, from = connector.from, to = connector.to, ...rest } = params;
  return {
    ...connector,
    ...rest,
    id: connector.id,
    from: fromSide === undefined ? from : { ...from, side: fromSide },
    to: toSide === undefined ? to : { ...to, side: toSide },
  };
}

/** `connectors` with a change applied. */
export const withConnectorChange = (connectors: readonly Connector[], change: ConnectorChange): Connector[] =>
  change.type === 'connector.updated'
    ? withConnector(connectors, change.connector)
    : connectors.filter((c) => c.id !== change.id);

/** The side of `rect` that `point` is nearest, measured in the rectangle's own proportions so a wide one isn't all top and bottom. */
export function nearestSide(rect: Rect, point: { x: number; y: number }): ConnectorSide {
  const dx = (point.x - (rect.x + rect.width / 2)) / rect.width;
  const dy = (point.y - (rect.y + rect.height / 2)) / rect.height;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/** The point `share` (0 to 1) of the way along `side` of `rect`: from the left of its top or bottom, from the top of its left or right. */
function sidePoint(rect: Rect, side: ConnectorSide, share: number): { x: number; y: number } {
  if (side === 'top' || side === 'bottom') return { x: rect.x + rect.width * share, y: side === 'top' ? rect.y : rect.y + rect.height };
  return { x: side === 'left' ? rect.x : rect.x + rect.width, y: rect.y + rect.height * share };
}

const centreOf = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const measured = (rect: Rect | undefined): rect is Rect => rect !== undefined && rect.width > 0 && rect.height > 0;

/**
 * The sides a line between `source` and `target` joins: each `auto` end on the side of its object facing the
 * other's centre, by `nearestSide`, so the edges each way between two tiles join the same pair of sides; a side the
 * user picked is kept. Until both objects are measured, an automatic end is on the right of its source or the left of
 * its target, as edges were drawn before. Two tiles on the same centre face nowhere: both ends are on the right.
 */
export function autoSides(
  fromSide: FlowEdgeSide,
  toSide: FlowEdgeSide,
  source: Rect | undefined,
  target: Rect | undefined,
): { fromSide: ConnectorSide; toSide: ConnectorSide } {
  const known = measured(source) && measured(target);
  return {
    fromSide: fromSide !== 'auto' ? fromSide : known ? nearestSide(source, centreOf(target)) : 'right',
    toSide: toSide !== 'auto' ? toSide : known ? nearestSide(target, centreOf(source)) : 'left',
  };
}

/**
 * Where a new note goes when a connector is dropped on empty board at `drop`: its side facing `source` sits at the drop
 * point, so the line arrives straight on. Returns the note's centre and that side.
 */
export function newEndAt(
  source: Rect,
  drop: { x: number; y: number },
  size: { width: number; height: number },
): { centre: { x: number; y: number }; side: ConnectorSide } {
  const dx = source.x + source.width / 2 - drop.x;
  const dy = source.y + source.height / 2 - drop.y;
  const side: ConnectorSide = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'bottom' : 'top';
  const half = { x: size.width / 2, y: size.height / 2 };
  const toSide = {
    top: { x: 0, y: -half.y },
    bottom: { x: 0, y: half.y },
    left: { x: -half.x, y: 0 },
    right: { x: half.x, y: 0 },
  }[side];
  return { centre: { x: drop.x - toSide.x, y: drop.y - toSide.y }, side };
}

/**
 * Where a line meets its tiles at each automatic end: the sides `autoSides` picks, and on each automatic one its
 * middle. An end on a side the user picked has no point here: it is drawn where its handle is.
 */
export function autoEnds(
  fromSide: FlowEdgeSide,
  toSide: FlowEdgeSide,
  source: Rect | undefined,
  target: Rect | undefined,
): { fromSide: ConnectorSide; toSide: ConnectorSide; source?: EdgePoint; target?: EdgePoint } {
  const sides = autoSides(fromSide, toSide, source, target);
  if (!measured(source) || !measured(target)) return sides;
  return {
    ...sides,
    ...(fromSide === 'auto' && { source: sidePoint(source, sides.fromSide, 0.5) }),
    ...(toSide === 'auto' && { target: sidePoint(target, sides.toSide, 0.5) }),
  };
}
