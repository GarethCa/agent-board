// Which of the session window's sidebar controls work right now. Pure, so the rules are unit-tested.
import { INTERRUPTIBLE_STATES, type Agent } from '@agent-board/daemon/protocol';

export type ControlId = 'interrupt' | 'pause' | 'handOff' | 'fork' | 'stop' | 'connections';

export interface Control {
  id: ControlId;
  label: string;
  enabled: boolean;
  /** What it does, or why it can't now. */
  hint: string;
}

const NOT_BUILT = 'Not built yet';

/**
 * The sidebar's controls, in order, for an agent's session or, with no `agent`, a shell's. `live` says whether the
 * window still has the session: it has not exited, and the window could attach to it.
 */
export function sessionControls({ agent, live }: { agent?: Agent; live: boolean }): Control[] {
  const running = live && (agent === undefined || agent.endedAt === null);
  const midTurn = agent === undefined || INTERRUPTIBLE_STATES.has(agent.state);
  const ended = 'The session has ended';
  return [
    {
      id: 'interrupt',
      label: 'Interrupt',
      enabled: running && midTurn,
      hint: !running ? ended : midTurn ? 'Interrupt what it is doing (Ctrl-C)' : 'It has no turn under way to interrupt',
    },
    { id: 'pause', label: 'Pause', enabled: false, hint: NOT_BUILT },
    { id: 'handOff', label: 'Hand off', enabled: false, hint: NOT_BUILT },
    { id: 'fork', label: 'Fork', enabled: false, hint: NOT_BUILT },
    {
      id: 'stop',
      label: 'Stop',
      enabled: running,
      hint: !running ? ended : agent ? 'End its session; its worktree and branch stay' : 'End the session',
    },
    { id: 'connections', label: 'Connections', enabled: false, hint: NOT_BUILT },
  ];
}
