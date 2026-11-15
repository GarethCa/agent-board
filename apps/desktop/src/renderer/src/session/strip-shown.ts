import type { PaneStatus } from './TerminalPane';

/**
 * Whether a window's status row is drawn, and whether it says the focused pane's state. A split window's panes
 * show their own state in their tabs, so its row is only for what is amiss: a pane that ended, lost the daemon or
 * could not open (not the window's own agent ending), a shell outside the agent's folder, or a problem of the window's own.
 */
export function stripShown(split: boolean, astray: boolean, problem: boolean, pane: Pick<PaneStatus, 'state'>, ownAgent: boolean): { row: boolean; paneStatus: boolean } {
  // The window's own agent that ended is told by its exit banner, and its state by the header: only a shell's or another session's exit is not.
  const amiss = (pane.state === 'exited' && !ownAgent) || pane.state === 'detached' || pane.state === 'unavailable';
  return { row: !split || astray || problem || amiss, paneStatus: !split || amiss };
}
