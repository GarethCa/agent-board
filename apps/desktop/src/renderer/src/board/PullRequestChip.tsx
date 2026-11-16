import type { ReactNode } from 'react';
import { ArrowUpRight, Check, Dot, X } from 'lucide-react';
import type { ChecksState, PullRequest } from '@agent-board/daemon/protocol';
import { Chip } from '../ui';
import { checksLabel } from './tile-footer';
import { stopPropagation } from './tile-parts';

const CHECK_MARKS: Record<ChecksState, ReactNode> = {
  passing: <Check aria-hidden />,
  failing: <X aria-hidden />,
  pending: <Dot aria-hidden />,
  none: null,
};

/**
 * A pull request made from the agent's branch: its number in its state's colour, and a mark for its checks. One of a
 * branch it `pushed` to leads with an arrow and says so; it is only shown, as it isn't the agent's own.
 */
export function PullRequestChip({ pr, pushed = false, open }: { pr: PullRequest; pushed?: boolean; open(): void }) {
  const checks = checksLabel(pr);
  return (
    <Chip
      mono
      icon={pushed ? <ArrowUpRight aria-hidden /> : undefined}
      className="hybrid-tile-pr nodrag"
      data-testid="tile-pr"
      data-state={pr.state}
      data-checks={pr.checks}
      data-pushed={pushed || undefined}
      aria-label={`${pushed ? 'Pushed to pull request' : 'Pull request'} #${pr.number}, ${pr.state}, ${checks}`}
      title={`${pushed ? 'Pushed to ' : ''}#${pr.number} ${pr.title}\n${pr.state}, ${checks}. Open it in a PR tab.`}
      onClick={open}
      onDoubleClick={stopPropagation}
    >
      #{pr.number}
      {pr.checks !== 'none' && <span className="hybrid-tile-pr-checks">{CHECK_MARKS[pr.checks]}</span>}
    </Chip>
  );
}
