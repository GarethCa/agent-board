import type { Agent } from '@agent-board/daemon/protocol';

/** Why the composer can't send, and the action that gets the agent going again. */
export interface ComposerBlock {
  reason: string;
  /** Absent for an ended agent that can't restart, such as a reviewer. */
  action?: 'show-prompt' | 'resume' | 'restart';
}

/**
 * Whether the composer is blocked for `agent`: undefined when it can send. A live agent takes a message in any state
 * but a pending permission prompt or Claude's question dialog, where typed text would answer it; a paused one too, which wakes with it; an
 * ended one takes none.
 */
export function composerBlock(agent: Pick<Agent, 'endedAt' | 'state' | 'reviewOf'> & Partial<Pick<Agent, 'permissions'>>): ComposerBlock | undefined {
  if (agent.state === 'hibernated') return undefined;
  if (agent.state === 'stopped-by-restart') return { reason: 'Stopped by a restart', action: 'resume' };
  if (agent.endedAt !== null) return agent.reviewOf === null ? { reason: 'The agent has ended', action: 'restart' } : { reason: 'The agent has ended' };
  if (agent.state === 'needs-permission') return { reason: 'Waiting on a permission prompt', action: 'show-prompt' };
  // Claude's question dialog is up in its terminal: typed text would land in it, and only it takes the answers.
  if (agent.permissions?.some((prompt) => prompt.questions !== null) === true) return { reason: 'Its questions wait in its terminal', action: 'show-prompt' };
  return undefined;
}

/**
 * What the empty field says under the Simplified design: the reason it is off, or a sentence for the state the agent is
 * in (paused, rate-limited, a message queued until it is up), else `fallback` (the Captain's "Ask the Captain…"), else an
 * invitation: "Reply…" while the agent waits on the user and "Message this agent…" otherwise.
 */
export function composerPlaceholder(agent: Pick<Agent, 'endedAt' | 'state' | 'reviewOf' | 'queuedUntilUp'>, fallback?: string): string {
  const blocked = composerBlock(agent);
  if (blocked !== undefined) return blocked.reason;
  if (agent.state === 'hibernated') return 'Paused: sending wakes it';
  if (agent.state === 'rate-limited') return 'Rate-limited: your message will wait';
  if (agent.queuedUntilUp > 0) return `${agent.queuedUntilUp} ${agent.queuedUntilUp === 1 ? 'message' : 'messages'} queued until it is up`;
  return fallback ?? (agent.state === 'waiting' ? 'Reply…' : 'Message this agent…');
}
