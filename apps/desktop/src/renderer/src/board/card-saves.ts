/** Where a card was moved to, saved with its question. */
export type PlaceCard = (sessionId: string, askId: string, at: { x: number; y: number }) => Promise<void>;

/**
 * The question cards' moves waiting to be saved: each saved `pauseMs` after its card's last move, the latest place
 * only. A question that goes in the meantime (answered, often by the key right after an arrow's step) drops its save,
 * and a save that fails because the question went as it was sent is no failure to report: the card is gone.
 */
export function cardSaves(place: PlaceCard, pauseMs: number, asking: (askId: string) => boolean, onError: (error: unknown) => void) {
  const pending = new Map<string, { askId: string; timer: ReturnType<typeof setTimeout> }>();
  const drop = (cardId: string) => {
    clearTimeout(pending.get(cardId)?.timer);
    pending.delete(cardId);
  };
  return {
    /** Saves the card `cardId` at `at` once it has stayed there `pauseMs`. */
    moved(cardId: string, sessionId: string, askId: string, at: { x: number; y: number }) {
      drop(cardId);
      const timer = setTimeout(() => {
        pending.delete(cardId);
        place(sessionId, askId, at).catch((error: unknown) => {
          if (asking(askId)) onError(error);
        });
      }, pauseMs);
      pending.set(cardId, { askId, timer });
    },
    /** Drops the saves of questions no longer asked. */
    keepOnly(askIds: ReadonlySet<string>) {
      for (const [cardId, { askId }] of pending) if (!askIds.has(askId)) drop(cardId);
    },
    dispose() {
      for (const cardId of [...pending.keys()]) drop(cardId);
    },
  };
}
