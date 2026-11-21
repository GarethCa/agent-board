// What the review viewer shows, from the implementer's review rounds. Pure, so it is unit-tested. When a
// round may start or merge is `startBlocked` and `mergeBlocked` in `@agent-board/daemon/review-doc`, which the daemon
// checks too.
import type { Agent, ReviewRound, ReviewUpdatedEvent } from '@agent-board/daemon/protocol';
import { parseReviewDoc } from '@agent-board/daemon/review-doc';
import type { PullRequestSurface } from '@agent-board/daemon/window-layout';
import { pullRequestSurfaceOf } from '../session/tabs';

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

/**
 * Whose review a pop-up's Review view shows, of `who` (its chat first), with their rounds: the one asked for from a
 * tile while it has a round, else the first whose latest round isn't dismissed, else the first with any round, so a
 * dismissed round's doc can still be opened from the sidebar. Undefined while none of them has a round.
 */
export function reviewedOf<T extends { sessionId: string }>(who: readonly T[], rounds: readonly ReviewRound[], asked: string | undefined): { agent: T; rounds: ReviewRound[] } | undefined {
  const each = who.map((agent) => ({ agent, rounds: roundsOf(rounds, agent.sessionId) })).filter((one) => one.rounds.length > 0);
  return each.find((one) => one.agent.sessionId === asked) ?? each.find((one) => showsReviewTab(one.rounds, false)) ?? each[0];
}

/** The pull request a reviewer reviews, and where its latest round is: being written, failed, or ready with its findings. */
export type ReviewedPullRequest = { surface: PullRequestSurface } & ({ status: 'reviewing' } | { status: 'failed' } | { status: 'ready'; findings: number });

/**
 * What each reviewer reviews, by its session: its implementer's newest pull request, and its latest round's findings.
 * A reviewer whose implementer has no pull request is left out.
 */
export function reviewedPullRequests(rounds: readonly ReviewRound[], agents: readonly Agent[]): Map<string, ReviewedPullRequest> {
  const found = new Map<string, { reviewed: ReviewedPullRequest; round: number }>();
  for (const round of rounds) {
    if (round.reviewer === null || (found.get(round.reviewer)?.round ?? 0) > round.round) continue;
    const implementer = agents.find((agent) => agent.sessionId === round.implementer);
    const surface = implementer?.pullRequests.flatMap((known) => pullRequestSurfaceOf(known) ?? [])[0];
    if (surface === undefined) continue;
    const reviewed: ReviewedPullRequest =
      round.status === 'ready' && round.doc !== null
        ? { surface, status: 'ready', findings: parseReviewDoc(round.doc).findings.length }
        : { surface, status: round.status === 'failed' ? 'failed' : 'reviewing' };
    found.set(round.reviewer, { reviewed, round: round.round });
  }
  return new Map([...found].map(([reviewer, { reviewed }]) => [reviewer, reviewed]));
}
