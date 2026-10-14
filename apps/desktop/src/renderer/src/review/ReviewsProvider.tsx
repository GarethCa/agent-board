import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import type { ReviewRound, ReviewUpdatedEvent } from '@agent-board/daemon/protocol';
import { withReviewChange } from './reviews';

/** None outside a provider: a gallery's tiles have no reviews. */
const ReviewsContext = createContext<readonly ReviewRound[]>([]);

/** Every implementer's review rounds, as the daemon has them and every window hears them change. */
export function ReviewsProvider({ children }: { children: ReactNode }) {
  const [rounds, setRounds] = useState<readonly ReviewRound[]>([]);
  // Subscribed before the list: a change that crossed it is applied again on top.
  useEffect(() => {
    let backlog: ReviewUpdatedEvent[] | undefined = [];
    let cancelled = false;
    const unsubscribe = window.agentBoard.reviews.onChanged((change) => {
      if (backlog !== undefined) backlog.push(change);
      else setRounds((current) => withReviewChange(current, change));
    });
    window.agentBoard.reviews.list().then(
      (listed) => {
        if (cancelled) return;
        setRounds(backlog!.reduce(withReviewChange, listed));
        backlog = undefined;
      },
      // Without them there is just no Review tab; a round that changes shows again.
      () => (backlog = undefined),
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return <ReviewsContext value={rounds}>{children}</ReviewsContext>;
}

/** Every implementer's review rounds (`roundsOf` picks one's). */
export function useReviews(): readonly ReviewRound[] {
  return use(ReviewsContext);
}
