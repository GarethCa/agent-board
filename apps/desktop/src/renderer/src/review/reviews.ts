// What the review viewer (AD2) shows, from the implementer's review rounds. Pure, so it is unit-tested. When a
// round may start or merge is `startBlocked` and `mergeBlocked` in `@agent-board/daemon/review-doc`, which the daemon
// checks too.
import type { ReviewRound, ReviewUpdatedEvent } from '@agent-board/daemon/protocol';

/** The rounds after a change the daemon announced. */
export function withReviewChange(rounds: readonly ReviewRound[], { round }: ReviewUpdatedEvent): ReviewRound[] {
  return rounds.some((known) => known.id === round.id) ? rounds.map((known) => (known.id === round.id ? round : known)) : [...rounds, round];
}

/** The implementer's rounds, first to last. */
export function roundsOf(rounds: readonly ReviewRound[], implementer: string): ReviewRound[] {
  return rounds.filter((round) => round.implementer === implementer).sort((a, b) => a.round - b.round);
}

/**
 * Whether its session window has a Review tab: while it has a round and the latest isn't dismissed, or once `asked` for
 * (from its tile) while it has any, so a dismissed round's doc can still be read.
 */
export function showsReviewTab(rounds: readonly ReviewRound[], asked: boolean): boolean {
  const latest = rounds.at(-1);
  return latest !== undefined && (asked || latest.dismissedAt === null);
}
