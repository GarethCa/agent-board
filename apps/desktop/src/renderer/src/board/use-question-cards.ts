import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, type NodeChange } from '@xyflow/react';
import type { Agent } from '@agent-board/daemon/protocol';
import { cardSaves } from './card-saves';
import { questionCardNodes, type QuestionNodeType } from './question-cards';
import type { BoardNode } from './tiles';

/** What React Flow keeps of a card while its question lasts: its measured size, selection, and where it was dragged. */
interface Live {
  askId: string;
  measured?: QuestionNodeType['measured'];
  selected?: boolean;
  dragging?: boolean;
  position?: QuestionNodeType['position'];
}

/** How long after the last arrow-key move a card's place is saved, as a tile's nudge is. */
const SAVE_PAUSE_MS = 400;

/**
 * The question cards on the board, from the agents' questions and the tiles as drawn, and the React Flow state each
 * keeps while its question lasts (a new question starts afresh). `apply` takes React Flow's changes to the cards: a
 * card measured is placed by its drawn size, and one moved, by a drag or the arrow keys, has its place saved with its
 * question once the move ends, so it stays there.
 */
export function useQuestionCards(agents: readonly Agent[], shown: readonly BoardNode[], onError: (error: unknown) => void) {
  const [live, setLive] = useState<Readonly<Record<string, Live>>>({});
  const cards = useMemo(() => {
    const sizes = new Map(
      Object.values(live).flatMap((kept) => (kept.measured?.width && kept.measured.height ? [[kept.askId, { width: kept.measured.width, height: kept.measured.height }] as const] : [])),
    );
    return questionCardNodes(agents, shown, sizes).map((card): QuestionNodeType => {
      const kept = live[card.id];
      if (kept?.askId !== card.data.ask.id) return card;
      const { measured, selected, dragging, position } = kept;
      // Once moved, the card no longer points at the tile: a tether joins them.
      return { ...card, measured, selected, dragging, ...(position && { position, data: { ...card.data, side: null } }) };
    });
  }, [agents, shown, live]);
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const saves = useRef<ReturnType<typeof cardSaves>>(undefined);
  saves.current ??= cardSaves(
    (sessionId, askId, at) => window.agentBoard.asks.place(sessionId, askId, at),
    SAVE_PAUSE_MS,
    (askId) => cardsRef.current.some((card) => card.data.ask.id === askId),
    (error) => onErrorRef.current(error),
  );
  useEffect(() => () => saves.current?.dispose(), []);
  // A question gone (answered, often by the key right after an arrow's step) drops its card's waiting save.
  useEffect(() => saves.current?.keepOnly(new Set(cards.map((card) => card.data.ask.id))), [cards]);

  const apply = useCallback((changes: NodeChange<QuestionNodeType>[]) => {
    const applied = applyNodeChanges(changes, cardsRef.current);
    const moved = new Set(changes.flatMap((change) => (change.type === 'position' && change.position !== undefined ? [change.id] : [])));
    // A move that ended (a drop, or an arrow key's step): saved once they stop.
    const ended = new Set(changes.flatMap((change) => (change.type === 'position' && change.position !== undefined && change.dragging !== true ? [change.id] : [])));
    for (const card of applied.filter((known) => ended.has(known.id))) saves.current?.moved(card.id, card.data.sessionId, card.data.ask.id, card.position);
    setLive((current) =>
      Object.fromEntries(
        applied.map((card) => {
          const kept = current[card.id]?.askId === card.data.ask.id ? current[card.id] : undefined;
          const position = moved.has(card.id) ? card.position : kept?.position;
          return [card.id, { askId: card.data.ask.id, measured: card.measured, selected: card.selected, dragging: card.dragging, ...(position && { position }) }];
        }),
      ),
    );
  }, []);

  return { cards, apply };
}
