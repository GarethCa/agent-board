import type { Agent } from '@agent-board/daemon/protocol';
import { EmptyState } from '../ui';
import { useReviews } from './ReviewsProvider';
import { roundsOf } from './reviews';
import { ReviewViewer } from './ReviewViewer';

/**
 * An implementer's review rounds in a pane of their own, as its window's Review tab shows them, so its pull request can
 * sit beside them. A round dismissed here stays shown: the tab closes as any tab does.
 */
export function ReviewTab({ implementer }: { implementer: Agent }) {
  const rounds = roundsOf(useReviews(), implementer.sessionId);
  if (rounds.length === 0) return <EmptyState title="No review yet">Its rounds show here once a reviewer starts one.</EmptyState>;
  return <ReviewViewer key={rounds.length} implementer={implementer} rounds={rounds} onDismissed={() => {}} />;
}
