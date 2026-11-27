import { useState } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { restartsInPlace, WAKE_ENDED_HINT, wakeBusyText } from '../board/paused';
import { WakeButton } from '../board/WakeButton';
import { Button, ErrorText } from '../ui';

export { canRestart } from '../board/paused';

/** Whether the running agent can be stopped and restarted in place: the daemon will accept the restart once it has ended. */
export const canRestartLive = (agent: Agent): boolean => agent.endedAt === null && restartsInPlace(agent);

/**
 * How an ended agent's process went, for its pane's banner over Wake: "Done. Wake carries on this conversation.", or for
 * one that exited on an error, "Exited on an error (code 1). …", its code only when it isn't 0.
 */
export function exitText(agent: Pick<Agent, 'state' | 'exitCode'>): string {
  if (agent.state !== 'failed') return 'Done. Wake carries on this conversation.';
  const code = agent.exitCode === null || agent.exitCode === 0 ? '' : ` (code ${agent.exitCode})`;
  return `Exited on an error${code}. Wake carries on this conversation.`;
}

/** The shell an ended agent's pane dropped into, when it has one: what its state says on the tile and the window. */
const ENDED_SHELL_LABEL = 'ended · shell';

/** What the tile and window say of an ended agent's shell: its harness is running in it by hand, or it is a plain shell. */
export const endedShellLabel = (agent: Pick<Agent, 'shellHarness'>): string =>
  agent.shellHarness === null ? ENDED_SHELL_LABEL : `${agent.shellHarness} running in this shell`;

/**
 * What Wake asks, in place, while the shell an agent's pane dropped into runs something (`message`, the daemon's
 * words): the board's own confirm, in a line, for the windows with no board to ask from.
 */
export function WakeBusyConfirm({ message, pending, onWake, onCancel, className }: { message: string; pending: boolean; onWake(): void; onCancel(): void; className?: string }) {
  return (
    <span className={`restart-agent ${className ?? ''}`} role="alert" data-testid="restart-agent-busy">
      {wakeBusyText(message)} Wake it anyway?
      <Button size="xs" variant="danger" disabled={pending} onClick={onWake}>
        Wake anyway
      </Button>
      <Button size="xs" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </span>
  );
}

/**
 * Wake, for an agent that is not running: relaunches it in its worktree, carrying on its conversation. If the shell its
 * pane dropped into is running something it asks first, in place, as a popped-out window has no board to ask from.
 */
export function RestartAgent({
  agent,
  className,
  label = 'Wake',
  hint = WAKE_ENDED_HINT,
  testId = 'restart-agent',
}: {
  agent: Agent;
  className?: string;
  label?: string;
  hint?: string;
  testId?: string;
}) {
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const restart = (force: boolean): Promise<void> => {
    setPending(true);
    setProblem(undefined);
    return window.agentBoard.agents
      .restart(agent.sessionId, force)
      .then(
        (result) => setBusy(result.status === 'busy' ? result.message : undefined),
        (error: unknown) => setProblem(`Could not wake it: ${errorMessage(error)}`),
      )
      .finally(() => setPending(false));
  };
  if (busy !== undefined) {
    return <WakeBusyConfirm message={busy} pending={pending} className={className} onWake={() => void restart(true)} onCancel={() => setBusy(undefined)} />;
  }
  return (
    <span className={`restart-agent ${className ?? ''}`}>
      <WakeButton label={label} hint={hint} testId={testId} onWake={() => restart(false)} />
      {problem && <ErrorText>{problem}</ErrorText>}
    </span>
  );
}
