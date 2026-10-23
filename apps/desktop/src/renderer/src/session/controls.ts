// Which of the session window's sidebar controls work right now. Pure, so the rules are unit-tested.
import { isMidTurn, type Agent } from '@agent-board/daemon/protocol';
import { pauseControl } from '../board/paused';

export type ControlId = 'interrupt' | 'pause' | 'wake' | 'stop';

export interface Control {
  id: ControlId;
  label: string;
  enabled: boolean;
  /** What it does, or why it can't now. */
  hint: string;
}

/**
 * The sidebar's controls, in order, for an agent's session or, with no `agent`, a shell's. `live` says whether the
 * window still has the session: it has not exited, and the window could attach to it. An agent has Pause too, or Wake
 * while it is paused.
 */
export function sessionControls({ agent, live }: { agent?: Agent; live: boolean }): Control[] {
  const running = live && (agent === undefined || agent.endedAt === null);
  const midTurn = agent === undefined || isMidTurn(agent);
  const ended = 'The session has ended';
  const pause = agent === undefined ? undefined : pauseControl(agent);
  const paused: Control[] =
    pause === undefined
      ? []
      : pause.action === 'wake'
        ? [{ id: 'wake', label: 'Wake', enabled: true, hint: pause.hint }]
        : [{ id: 'pause', label: 'Pause', enabled: running && pause.enabled, hint: running ? pause.hint : ended }];
  return [
    {
      id: 'interrupt',
      label: 'Interrupt',
      enabled: running && midTurn,
      hint: !running ? ended : midTurn ? 'Interrupt what it is doing (Ctrl-C)' : 'It has no turn under way to interrupt',
    },
    ...paused,
    {
      id: 'stop',
      label: 'Stop',
      // A paused agent can be closed for good as it is, never woken.
      enabled: running || agent?.state === 'hibernated',
      hint:
        agent?.state === 'hibernated'
          ? 'Close it as it is, no longer paused: its worktree and branch stay'
          : !running
            ? ended
            : agent
              ? 'End its session; its worktree and branch stay'
              : 'End the session',
    },
  ];
}
