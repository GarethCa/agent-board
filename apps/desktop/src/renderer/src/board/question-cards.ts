// A question card: an agent's question on the board, beside its tile, when it asked for one (`ask` with `on_board`).
// Derived from the agent's question, never stored as an item: it goes as the question does, answered on the card or
// in the inbox, skipped, timed out or dropped. Where the user moved it is kept with the question, in the daemon.
import type { Edge, Node } from '@xyflow/react';
import type { Agent, AgentAsk, ConnectorSide } from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { TETHER_EDGE_TYPE } from './items/agent-note-tethers';
import { tileNodeId, type BoardNode } from './tiles';

export const QUESTION_CARD_TYPE = 'question';
const QUESTION_NODE_PREFIX = 'question:';
/** The card's width, as the mock draws it. */
export const QUESTION_CARD_WIDTH = 268;
/** The space between a tile and the card beside it, its tail across it. */
export const CARD_GAP = 14;
/** Over every tile and item while it waits: it floats above the board, as a popover would. */
const QUESTION_Z_INDEX = 2000;

export interface QuestionCardData extends Record<string, unknown> {
  sessionId: string;
  /** The asking agent's name, for the card's head. */
  name: string;
  ask: AgentAsk;
  /** The card's side its tail points from, at the tile beside it; null once the user moved it, a tether joining them instead. */
  side: ConnectorSide | null;
}

export type QuestionNodeType = Node<QuestionCardData, typeof QUESTION_CARD_TYPE>;

export const questionNodeId = (sessionId: string) => `${QUESTION_NODE_PREFIX}${sessionId}`;

export const isQuestionNodeId = (id: string) => id.startsWith(QUESTION_NODE_PREFIX);

type Rect = { x: number; y: number; width: number; height: number };

/** About how tall the card draws: its head, the question's lines, a row per option and the reply field. */
export function questionCardSize(ask: AgentAsk): { width: number; height: number } {
  const lines = Math.max(1, Math.ceil(ask.question.length / 34));
  const parts = [14, lines * 18, ...ask.options.map(() => 28), ...(ask.freeText ? [30] : [])];
  return { width: QUESTION_CARD_WIDTH, height: 22 + parts.reduce((sum, part) => sum + part, 0) + (parts.length - 1) * 8 };
}

/** Where each top-level node is on the board, so a tile in a zone is measured from the zone's corner. */
function boardRects(nodes: readonly Node[]): Map<string, Rect> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rects = new Map<string, Rect>();
  for (const node of nodes) {
    const parent = node.parentId === undefined ? undefined : byId.get(node.parentId);
    rects.set(node.id, {
      x: node.position.x + (parent?.position.x ?? 0),
      y: node.position.y + (parent?.position.y ?? 0),
      width: node.measured?.width ?? node.width ?? AGENT_TILE_SIZE.width,
      height: node.measured?.height ?? node.height ?? AGENT_TILE_SIZE.height,
    });
  }
  return rects;
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Beside `tile`, clear of `others`: on its right first, then below it, on its left and above it. With no gap, on its
 * right all the same, over what is there.
 */
function beside(tile: Rect, size: { width: number; height: number }, others: readonly Rect[]): { at: { x: number; y: number }; side: ConnectorSide } {
  const places: { at: { x: number; y: number }; side: ConnectorSide }[] = [
    { at: { x: tile.x + tile.width + CARD_GAP, y: tile.y }, side: 'left' },
    { at: { x: tile.x, y: tile.y + tile.height + CARD_GAP }, side: 'top' },
    { at: { x: tile.x - CARD_GAP - size.width, y: tile.y }, side: 'right' },
    { at: { x: tile.x, y: tile.y - CARD_GAP - size.height }, side: 'bottom' },
  ];
  return places.find(({ at }) => !others.some((other) => overlaps({ ...at, ...size }, other))) ?? places[0]!;
}

/**
 * A card for each live agent asking a question it wants on the board, while its tile is on the board: where the user
 * moved it, else beside the tile, clear of the tiles and items around it (zones hold them, so they don't count). A card
 * is placed by its size as drawn (`measured`, by question id) once it has been, else by `questionCardSize`.
 */
export function questionCardNodes(
  agents: readonly Agent[],
  nodes: readonly BoardNode[],
  measured: ReadonlyMap<string, { width: number; height: number }> = new Map(),
): QuestionNodeType[] {
  const sizeOf = (ask: AgentAsk) => measured.get(ask.id) ?? questionCardSize(ask);
  const rects = boardRects(nodes);
  const asking = agents.filter((agent) => agent.ask?.onBoard === true && agent.endedAt === null && rects.has(tileNodeId('agent', agent.sessionId)));
  // The cards the user moved are where they are; the rest keep clear of them, and of each other as each is placed.
  const cards: Rect[] = asking.flatMap(({ ask }) => (ask!.at === null ? [] : [{ ...ask!.at, ...sizeOf(ask!) }]));
  return asking.map((agent): QuestionNodeType => {
    const ask = agent.ask!;
    const tileId = tileNodeId('agent', agent.sessionId);
    const size = sizeOf(ask);
    const others = [...nodes.filter((node) => node.type !== 'zone' && node.id !== tileId).map((node) => rects.get(node.id)!), ...cards];
    const { at, side } = ask.at === null ? beside(rects.get(tileId)!, size, others) : { at: ask.at, side: null };
    if (ask.at === null) cards.push({ ...at, ...size });
    return {
      id: questionNodeId(agent.sessionId),
      type: QUESTION_CARD_TYPE,
      position: at,
      width: QUESTION_CARD_WIDTH,
      data: { sessionId: agent.sessionId, name: agent.name, ask, side },
      deletable: false,
      selectable: true,
      zIndex: QUESTION_Z_INDEX,
    };
  });
}

/** A dashed tether from each card the user moved away to its agent's tile, as an agent note has. */
export function questionTethers(cards: readonly QuestionNodeType[]): Edge[] {
  return cards
    .filter((card) => card.data.side === null)
    .map((card) => ({
      id: `tether:${card.id}`,
      type: TETHER_EDGE_TYPE,
      source: card.id,
      sourceHandle: 'bottom',
      target: tileNodeId('agent', card.data.sessionId),
      targetHandle: 'top',
      selectable: false,
      deletable: false,
      focusable: false,
      zIndex: 0,
      data: { tab: false },
    }));
}

/** How long ago the question was asked, as the card's head says it: "now", "4 min", "2 h". */
export function askedAgo(askedAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(askedAt)) / 60_000);
  if (minutes < 1) return 'now';
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}
