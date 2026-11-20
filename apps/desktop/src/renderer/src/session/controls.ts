// Which of the session window's sidebar controls work right now. Pure, so the rules are unit-tested.
import { isMidTurn, type Agent } from '@agent-board/daemon/protocol';
import { pauseControl, WAKE_ENDED_HINT, WAKE_NOW_HINT, wakeAct } from '../board/paused';

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
 * while it is paused, done or exited, or Wake now when its clock wakes it so (not a reviewer whose round ended, nor one whose harness runs in its shell).
 */
export function sessionControls({ agent, live }: { agent?: Agent; live: boolean }): Control[] {
  const running = live && (agent === undefined || agent.endedAt === null);
  const midTurn = agent === undefined || isMidTurn(agent);
  const ended = 'The session has ended';
  const pause = agent === undefined ? undefined : pauseControl(agent);
  const wake = agent === undefined ? undefined : wakeAct(agent);
  const paused: Control[] =
    wake === 'restart'
      ? [{ id: 'wake', label: 'Wake', enabled: true, hint: WAKE_ENDED_HINT }]
      : // Paused between runs or ended, its clock wakes it: Wake now runs its clock. At its prompt it has Pause, and Wake now in ⋯.
        wake === 'run-now' && pause?.action !== 'pause'
        ? [{ id: 'wake', label: 'Wake now', enabled: true, hint: WAKE_NOW_HINT }]
        : pause === undefined
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

/**
 * The header's one state button, of a window's controls: Wake while it is asleep, done or exited, else Interrupt mid-turn, else Pause.
 * Stop never leads; and one that has gone, with Stop no use either, has none, as the Simplified header has.
 */
export function leadControl(controls: readonly Control[]): Control | undefined {
  const wake = controls.find((control) => control.id === 'wake');
  if (wake !== undefined) return wake;
  if (controls.find((control) => control.id === 'stop')?.enabled !== true) return undefined;
  return controls.find((control) => control.id === 'interrupt' && control.enabled) ?? controls.find((control) => control.id === 'pause');
}
