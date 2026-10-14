// R1: an agent started from an issue is drawn fed by that issue's card, along a coloured flow edge labelled
// "issue brief". The edge is derived, never stored: a card and an agent linked to its issue are all it needs.
import type { Edge, Node } from '@xyflow/react';
import { issueCardData, type Agent, type IssueCardData, type LinkedIssue } from '@agent-board/daemon/protocol';
import { isItemNode, type ItemNodeType } from './items/items';
import { AGENT_NODE_PREFIX } from './tiles';

export const BRIEF_EDGE_TYPE = 'brief';
const BRIEF_EDGE_PREFIX = 'brief:';
/** Over the nodes, like connectors. */
const BRIEF_Z_INDEX = 3;

const isIssueCard = (node: Node): node is ItemNodeType => isItemNode(node) && node.data.item.kind === 'issue';
/** The card's issue; undefined for data that is not a card's, which no agent is fed from. */
const cardIssue = (node: ItemNodeType) => issueCardData(node.data.item.data);
const sameIssue = (card: IssueCardData | undefined, issue: Pick<LinkedIssue, 'provider' | 'id'>) =>
  card !== undefined && card.provider === issue.provider && card.id === issue.id;

/** An edge from each issue card to every agent on the board linked to its issue. */
export function briefEdges(nodes: readonly Node[], agents: readonly Agent[]): Edge[] {
  const onBoard = new Set(nodes.map((node) => node.id));
  return nodes.filter(isIssueCard).flatMap((card) =>
    agents
      .filter((agent) => agent.issue !== null && sameIssue(cardIssue(card), agent.issue))
      .map((agent) => `${AGENT_NODE_PREFIX}${agent.sessionId}`)
      .filter((tile) => onBoard.has(tile))
      .map(
        (tile): Edge => ({
          id: `${BRIEF_EDGE_PREFIX}${card.id}:${tile}`,
          type: BRIEF_EDGE_TYPE,
          source: card.id,
          sourceHandle: 'right',
          target: tile,
          targetHandle: 'left',
          selectable: false,
          deletable: false,
          zIndex: BRIEF_Z_INDEX,
        }),
      ),
  );
}

/** The card of `issue` in the zone (or loose on the board, for null), if the board has one. */
export function issueCardFor(
  nodes: readonly Node[],
  issue: Pick<LinkedIssue, 'provider' | 'id'>,
  zoneId: string | null,
): ItemNodeType | undefined {
  return nodes.filter(isIssueCard).find((card) => sameIssue(cardIssue(card), issue) && card.data.item.zoneId === zoneId);
}

/** Whether any agent is linked to the card's issue. */
export function cardHasAgent(card: IssueCardData, agents: readonly Agent[]): boolean {
  return agents.some((agent) => agent.issue !== null && sameIssue(card, agent.issue));
}
