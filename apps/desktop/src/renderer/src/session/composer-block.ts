import type { Agent } from '@agent-board/daemon/protocol';

/** Why the composer can't send, and the action that gets the agent going again. */
export interface ComposerBlock {
  reason: string;
  /** Absent for an ended agent that can't restart, such as a reviewer. */
  action?: 'show-prompt' | 'resume' | 'restart';
}

/**
 * Whether the composer is blocked for `agent`: undefined when it can send. A live agent takes a message in any state
 * but a pending permission prompt, where typed text would answer the prompt; a paused one too, which wakes with it; an
 * ended one takes none.
 */
export function composerBlock(agent: Pick<Agent, 'endedAt' | 'state' | 'reviewOf'>): ComposerBlock | undefined {
  if (agent.state === 'hibernated') return undefined;
  if (agent.state === 'stopped-by-restart') return { reason: 'Stopped by a restart', action: 'resume' };
  if (agent.endedAt !== null) return agent.reviewOf === null ? { reason: 'The agent has ended', action: 'restart' } : { reason: 'The agent has ended' };
  if (agent.state === 'needs-permission') return { reason: 'Waiting on a permission prompt', action: 'show-prompt' };
  return undefined;
}
