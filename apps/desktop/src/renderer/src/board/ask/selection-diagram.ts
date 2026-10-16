// A selection as Ask Claude sends it: the diagram the agent reads (short node ids, boxes from the selection's top-left),
// which board object each node is, and where on the board the answer and the agent's tile go.
import type { Connector, ConnectorEndType, SelectionDiagram, SelectionGroup } from '@agent-board/daemon/protocol';
import type { Rect } from '../../geometry';
import { boundsOf } from '../editing/snap';

/** One selected object, as the board has it. */
export interface DiagramObject {
  /** The board object it is, as a connector's end names it. */
  end: { type: ConnectorEndType; id: string };
  /** A board item's kind, or `agent`, `shell`, `external`. */
  kind: string;
  shape?: string;
  text?: string;
  /** Its box on the board. */
  rect: Rect;
  /** The zone it is in, if any, by name. */
  zone?: string;
}

/** What `selection.ask` needs of the selection, and the box round it. */
export interface SelectionAsk {
  diagram: SelectionDiagram;
  objects: Record<string, { type: ConnectorEndType; id: string }>;
  origin: { x: number; y: number };
  /** The node the answer's arrow leaves: the rightmost, nearest the note. */
  anchor: string;
  bounds: Rect;
  /** The connectors the diagram's edges are: the only ones drawn in its picture. */
  connectorIds: string[];
}

/** The gap between the selection and its answer note, px; and how far under the note's top the tile starts. */
const ANSWER_GAP = 48;
const TILE_DROP = 260;

/**
 * The selection `objects` as a diagram: each a node (`n1`, `n2`… in reading order), every connector joining two of them
 * an edge, and the zones they are in its groups.
 */
export function selectionAsk(objects: readonly DiagramObject[], connectors: readonly Connector[]): SelectionAsk | undefined {
  const bounds = boundsOf(objects.map((object) => object.rect));
  if (bounds === undefined) return undefined;
  const origin = { x: Math.round(bounds.x), y: Math.round(bounds.y) };
  // Top to bottom, then left to right, so the ids read as the diagram does.
  const ordered = [...objects].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const ids = new Map(ordered.map((object, index) => [key(object.end), `n${index + 1}`]));
  const nodes = ordered.map((object) => ({
    id: ids.get(key(object.end))!,
    kind: object.kind,
    ...(object.shape === undefined ? {} : { shape: object.shape }),
    ...(object.text === undefined || object.text.trim() === '' ? {} : { text: object.text.trim() }),
    x: Math.round(object.rect.x - origin.x),
    y: Math.round(object.rect.y - origin.y),
    width: Math.round(object.rect.width),
    height: Math.round(object.rect.height),
  }));
  const joining = connectors.filter((connector) => ids.has(key(connector.from)) && ids.has(key(connector.to)));
  const edges = joining.map((connector) => ({
    from: ids.get(key(connector.from))!,
    to: ids.get(key(connector.to))!,
    ...(connector.label.trim() === '' ? {} : { label: connector.label.trim() }),
  }));
  const groups = new Map<string, SelectionGroup>();
  for (const object of ordered) {
    if (object.zone === undefined) continue;
    const group = groups.get(object.zone) ?? { name: object.zone, nodes: [] };
    group.nodes.push(ids.get(key(object.end))!);
    groups.set(object.zone, group);
  }
  const anchor = ordered.reduce((best, object) => (right(object.rect) > right(best.rect) ? object : best));
  return {
    diagram: { nodes, edges, groups: [...groups.values()] },
    objects: Object.fromEntries(ordered.map((object) => [ids.get(key(object.end))!, object.end])),
    origin,
    anchor: ids.get(key(anchor.end))!,
    bounds,
    connectorIds: joining.map((connector) => connector.id),
  };
}

const key = (end: { type: string; id: string }) => `${end.type}:${end.id}`;
const right = (rect: Rect) => rect.x + rect.width;

/** Where the answer note and the agent's tile go on the board: to the right of the selection, the tile under the note. */
export function answerSpots(bounds: Rect): { note: { x: number; y: number }; tile: { x: number; y: number } } {
  const x = Math.round(bounds.x + bounds.width + ANSWER_GAP);
  const y = Math.round(bounds.y);
  return { note: { x, y }, tile: { x, y: y + TILE_DROP } };
}

/** "3 shapes · 2 arrows", as the popover and the selection's label say what is sent. */
export function selectionSummary(diagram: SelectionDiagram): string {
  const shapes = diagram.nodes.filter((node) => node.kind === 'shape').length;
  const others = diagram.nodes.length - shapes;
  const parts = [shapes > 0 && plural(shapes, 'shape'), others > 0 && plural(others, shapes > 0 ? 'other' : 'object'), diagram.edges.length > 0 && plural(diagram.edges.length, 'arrow')];
  return parts.filter(Boolean).join(' · ');
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * The zoom that draws the selection at `scale` picture pixels to a board px on a screen of `pixelRatio`, within
 * `maxZoom`; less when it wouldn't fit in `room` (CSS px) at that. Returns the zoom and the scale it gives.
 */
export function captureZoom(bounds: Rect, room: { width: number; height: number }, pixelRatio: number, maxZoom: number, scale = 2): { zoom: number; scale: number } {
  const fits = Math.min(room.width / bounds.width, room.height / bounds.height);
  const zoom = Math.min(scale / pixelRatio, maxZoom, fits);
  return { zoom, scale: zoom * pixelRatio };
}
