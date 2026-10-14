import { useState } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { RotateCcw } from 'lucide-react';
import { errorMessage } from '../../../shared/errors';
import { Button, ErrorText } from '../ui';

/**
 * Whether the agent ended on its own or was stopped (not by a restart, which has its own Resume): it can restart. Not
 * a reviewer, whose round ended with it.
 */
export const canRestart = (agent: Agent): boolean => agent.endedAt !== null && agent.state !== 'stopped-by-restart' && agent.reviewOf === null;

/** How an ended agent's process went, for its pane's banner: `claude exited (code 0)`. */
export function exitText(agent: Agent): string {
  return `${agent.harness} exited${agent.exitCode === null ? '' : ` (code ${agent.exitCode})`}`;
}

/** The shell an ended agent's pane dropped into, when it has one: what its state says on the tile and the window. */
export const ENDED_SHELL_LABEL = 'ended · shell';

/**
 * Restart agent, for an ended agent: relaunches it in its worktree, carrying on its conversation. If the shell its
 * pane dropped into is running something it asks first, in place, as a popped-out window has no board to ask from.
 */
export function RestartAgent({ agent, className, label = 'Restart agent', testId = 'restart-agent' }: { agent: Agent; className?: string; label?: string; testId?: string }) {
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const restart = (force: boolean) => {
    setPending(true);
    setProblem(undefined);
    window.agentBoard.agents
      .restart(agent.sessionId, force)
      .then(
        (result) => setBusy(result.status === 'busy' ? result.message : undefined),
        (error: unknown) => setProblem(`Could not restart: ${errorMessage(error)}`),
      )
      .finally(() => setPending(false));
  };
  if (busy !== undefined) {
    return (
      <span className={`restart-agent ${className ?? ''}`} role="alert" data-testid="restart-agent-busy">
        {busy}. Restart anyway?
        <Button size="xs" variant="danger" disabled={pending} onClick={() => restart(true)}>
          Restart anyway
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setBusy(undefined)}>
          Cancel
        </Button>
      </span>
    );
  }
  return (
    <span className={`restart-agent ${className ?? ''}`}>
      <Button size="xs" variant="primary" icon={<RotateCcw />} data-testid={testId} disabled={pending} onClick={() => restart(false)}>
        {label}
      </Button>
      {problem && <ErrorText>{problem}</ErrorText>}
    </span>
  );
}
