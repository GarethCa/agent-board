import { useState } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { RotateCcw } from 'lucide-react';
import { errorMessage } from '../../../shared/errors';
import { Button, ErrorText } from '../ui';

/** The agents a restart can carry on: not a reviewer, whose round ends with it, nor one with a harness running in its shell. */
const restartsInPlace = (agent: Agent): boolean => agent.reviewOf === null && agent.shellHarness === null;

/**
 * Whether the agent ended on its own or was stopped (not by a restart, which has its own Resume, nor paused, which has
 * Wake): it can restart. Not a reviewer, whose round ended with it.
 */
export const canRestart = (agent: Agent): boolean =>
  agent.endedAt !== null && agent.state !== 'stopped-by-restart' && agent.state !== 'hibernated' && restartsInPlace(agent);

/** Whether the running agent can be stopped and restarted in place: the daemon will accept the restart once it has ended. */
export const canRestartLive = (agent: Agent): boolean => agent.endedAt === null && restartsInPlace(agent);

/** How an ended agent's process went, for its pane's banner: `claude exited (code 0)`. */
export function exitText(agent: Agent): string {
  return `${agent.harness} exited${agent.exitCode === null ? '' : ` (code ${agent.exitCode})`}`;
}

/** The shell an ended agent's pane dropped into, when it has one: what its state says on the tile and the window. */
const ENDED_SHELL_LABEL = 'ended · shell';

/** What the tile and window say of an ended agent's shell: its harness is running in it by hand, or it is a plain shell. */
export const endedShellLabel = (agent: Pick<Agent, 'shellHarness'>): string =>
  agent.shellHarness === null ? ENDED_SHELL_LABEL : `${agent.shellHarness} running in this shell`;

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
