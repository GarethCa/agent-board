import { ScanEye } from 'lucide-react';
import type { Agent } from '@agent-board/daemon/protocol';

/**
 * A reviewer's mark after its state word on a glance tile: a small eye in the review ink, in every state, since its word
 * says In review only while it waits on its builder. Nothing for an agent that reviews nothing.
 */
export function ReviewerMark({ agent, implementer }: { agent: Pick<Agent, 'reviewOf'>; implementer?: Pick<Agent, 'name'> }) {
  if (agent.reviewOf === null) return null;
  return (
    <span
      className="tile-reviewer-mark"
      data-testid="tile-reviewer-mark"
      role="img"
      aria-label={implementer === undefined ? 'Reviewer' : `Reviewer of ${implementer.name}`}
      title={implementer === undefined ? "Reviews another agent's work" : `Reviews ${implementer.name}`}
    >
      <ScanEye aria-hidden />
    </span>
  );
}
