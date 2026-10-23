// An agent note is tied to its agent's tile by a dashed tether, so a note beside a crew says who keeps
// it without an edge into the crew. Derived, never stored: the note's agent is all it needs. Drawn with every
// connection shown, and never counted as one hidden.
import type { Edge, Node } from '@xyflow/react';
import { tileNodeId } from '../tiles';
import { agentNoteData } from './agent-note';
import { isItemNode, type ItemNodeType } from './items';

export const TETHER_EDGE_TYPE = 'tether';
const TETHER_EDGE_PREFIX = 'tether:';
/** Under the nodes: it leads to the tile, never across it. */
const TETHER_Z_INDEX = 0;

const isAgentNote = (node: Node): node is ItemNodeType => isItemNode(node) && node.data.item.kind === 'agent-note';
const isDocumentCard = (node: Node): node is ItemNodeType => isItemNode(node) && node.data.item.kind === 'document';

export const isTether = (edge: Edge): boolean => edge.type === TETHER_EDGE_TYPE;

/**
 * A tether from each agent note to the tile of the agent it is about (an answer, its author's), and from each document
 * card to the agent that showed it, while that tile is on the board.
 */
export function agentNoteTethers(nodes: readonly Node[]): Edge[] {
  const onBoard = new Set(nodes.map((node) => node.id));
  return nodes.filter((node) => isAgentNote(node) || isDocumentCard(node)).flatMap((note) => {
    const subject = tetheredTo(note);
    if (subject === undefined) return [];
    const tile = tileNodeId('agent', subject);
    if (!onBoard.has(tile)) return [];
    return [
      {
        id: `${TETHER_EDGE_PREFIX}${note.id}`,
        type: TETHER_EDGE_TYPE,
        source: note.id,
        // Handle ids are the connector handles' sides (`withConnectorHandles`: top, right, bottom, left), which every
        // note and tile has. React Flow needs one at each end to place the edge, but `TetherEdge` doesn't draw from
        // them: it joins the middles of the two sides that face each other, wherever the note and tile are.
        sourceHandle: 'bottom',
        target: tile,
        targetHandle: 'top',
        selectable: false,
        deletable: false,
        focusable: false,
        zIndex: TETHER_Z_INDEX,
      },
    ];
  });
}

/** The session of the agent an agent note or document card is tied to, if any. */
function tetheredTo(node: ItemNodeType): string | undefined {
  if (node.data.item.kind === 'document') return (node.data.item.data as { agent: { sessionId: string } }).agent.sessionId;
  // The agent a note is about, when it says (an orchestrator's note on a crew member); an answer to the user's
  // question, its author's. A note about no agent has none: no connector leads to the orchestrator that wrote it.
  const { agent, about, asked } = agentNoteData(node.data.item.data);
  return about ?? (asked === undefined ? undefined : agent.sessionId);
}
