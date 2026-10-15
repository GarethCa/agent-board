import type { Edge } from '@xyflow/react';
import type { Connector, ConnectorEnd, ConnectorEndType, ConnectorSide, FlowEdgeShape, UpdateConnectorParams } from '@agent-board/daemon/protocol';
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

/** How `connector` is drawn: the sides of its objects it joins, its style and its bends, as a flow edge has them. */
export const shapeOf = (connector: Connector): FlowEdgeShape => ({
  fromSide: connector.from.side,
  toSide: connector.to.side,
  style: connector.style,
  points: connector.points,
});

/** `connector` as `params` change it: its look, label or bends, or the side of an end. */
export function withConnectorParams(connector: Connector, params: UpdateConnectorParams): Connector {
  const { fromSide, toSide, ...rest } = params;
  return {
    ...connector,
    ...rest,
    id: connector.id,
    from: fromSide === undefined ? connector.from : { ...connector.from, side: fromSide },
    to: toSide === undefined ? connector.to : { ...connector.to, side: toSide },
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
