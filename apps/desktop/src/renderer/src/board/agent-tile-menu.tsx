// An agent tile's own menu, as its ⋯ and a right-click on it both draw it: the rows `agentTileMenu` lists, from the
// agent as it is now, its gate and reviews, the tiles it is linked to, and what the board does to the tile.
import { createContext, useContext, useReducer } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { useGateRun } from '../gate/GatesProvider';
import { useReviews } from '../review/ReviewsProvider';
import { roundsOf } from '../review/reviews';
import { ContextMenu } from '../ui';
import { useBoardCommands } from './commands';
import type { Reorder } from './editing/arrange';
import { agentTileMenu, type ModelEntry, type RelatedTile } from './menu-model';
import { ClickOpensContext, TileActionsContext, type TileData } from './tile';

/** What the board does to a tile, by its node id, for the tile's menu. */
export interface TileMenuBoard {
  /** Opens Ask Claude about the tile alone. */
  askClaude(nodeId: string): void;
  /** Brings the tile forward or to the front, or sends it back, among the tiles. */
  restack(nodeId: string, how: Reorder): void;
  /** Whether a connector can start at the tile. */
  joinable(nodeId: string): boolean;
  /** Whether the agent `sessionId` has a tile on the board. */
  onBoard(sessionId: string): boolean;
  /** Waits for a click on what to join the tile to. */
  connectFrom(nodeId: string): void;
  /** Whether the tile is a lead pinned top-left in its shelved zone; undefined for any other tile. */
  leadPinned(nodeId: string): boolean | undefined;
  setLeadPinned(nodeId: string, pinned: boolean): void;
  /** Puts the text on the clipboard, saying what it was. */
  copy(text: string, what: string): void;
}

/** The tiles its tile's data links an agent to: the orchestrator that started it, and for a reviewer, its implementer. */
export type TileLinks = Pick<TileData, 'from' | 'implementer'>;

const NOTHING: TileMenuBoard = {
  askClaude: () => {},
  restack: () => {},
  joinable: () => false,
  onBoard: () => false,
  connectFrom: () => {},
  leadPinned: () => undefined,
  setLeadPinned: () => {},
  copy: () => {},
};

export const TileMenuBoardContext = createContext<TileMenuBoard>(NOTHING);

/**
 * The tiles an agent's is linked to, still on the board: its implementer or its latest reviewer, and its orchestrator.
 * Only a crew member links to its orchestrator, not the other way: a crew is many tiles, which its frame already shows.
 */
function relatedTiles(agent: Agent, data: TileLinks, latestReviewer: string | null | undefined, onBoard: (sessionId: string) => boolean): RelatedTile[] {
  return [
    ...(data.implementer === undefined ? [] : [{ sessionId: data.implementer.sessionId, label: `Show ${data.implementer.name}` }]),
    ...(agent.reviewOf === null && latestReviewer != null && onBoard(latestReviewer) ? [{ sessionId: latestReviewer, label: 'Show its reviewer' }] : []),
    ...(data.from === undefined ? [] : [{ sessionId: data.from.sessionId, label: `Show ${data.from.name}` }]),
  ];
}

/**
 * The menu of the agent tile `nodeId`, linked to the tiles `links` names; `rename` starts renaming it in place. Call
 * `reread` as its menu opens: what the board says of the tile (pinned, joinable, its reviewer's tile) is read as the
 * tile draws, and a tile draws again only when its own data changes.
 */
export function useAgentTileMenu(nodeId: string, agent: Agent, links: TileLinks, rename: () => void): { entries: ModelEntry[]; reread(): void } {
  const [, reread] = useReducer((reads: number) => reads + 1, 0);
  const actions = useContext(TileActionsContext);
  const clickOpens = useContext(ClickOpensContext);
  const board = useContext(TileMenuBoardContext);
  const commands = useBoardCommands();
  const gate = useGateRun(agent.sessionId);
  const reviews = useReviews();
  const rounds = roundsOf(reviews, agent.sessionId);
  const review = agent.reviewOf === null ? undefined : roundsOf(reviews, agent.reviewOf).find((each) => each.reviewer === agent.sessionId);
  const pinned = board.leadPinned(nodeId);
  const entries = agentTileMenu({
    nodeId,
    agent,
    clickOpens,
    gate,
    rounds,
    review,
    rename,
    actions,
    related: relatedTiles(agent, links, rounds.at(-1)?.reviewer, board.onBoard),
    board: {
      askClaude: () => board.askClaude(nodeId),
      restack: (how) => board.restack(nodeId, how),
      ...(board.joinable(nodeId) ? { connect: () => board.connectFrom(nodeId) } : {}),
      ...(pinned === undefined ? {} : { leadPin: { pinned, toggle: () => board.setLeadPinned(nodeId, !pinned) } }),
      copy: board.copy,
      show: (sessionId) => void commands.showTile({ kind: 'agent', id: sessionId }),
    },
  });
  return { entries, reread };
}

/** An agent tile's menu where it was right-clicked. */
export function AgentContextMenu({
  nodeId,
  agent,
  links,
  at,
  rename,
  onClose,
}: {
  nodeId: string;
  agent: Agent;
  links: TileLinks;
  at: { x: number; y: number };
  rename(): void;
  onClose(): void;
}) {
  const { entries } = useAgentTileMenu(nodeId, agent, links, rename);
  return <ContextMenu at={at} label={agent.name} entries={entries} onClose={onClose} />;
}
