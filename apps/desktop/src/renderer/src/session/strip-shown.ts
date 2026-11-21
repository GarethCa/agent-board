import { OWN_SURFACE } from '@agent-board/daemon/window-layout';
import type { PaneStatus } from './TerminalPane';

/**
 * Whether a window's status row is drawn, and whether it says the focused pane's state. A split window's panes
 * show their own state in their tabs, so its row is only for what is amiss: a pane that ended, lost the daemon or
 * could not open (not the window's own agent ending), a shell outside the agent's folder, or a problem of the window's own.
 * So is a body drawn straight under a row of tabs of another's (`underTabs`), as a ticket's pop-up draws it.
 */
export function stripShown(split: boolean, astray: boolean, problem: boolean, pane: Pick<PaneStatus, 'state'>, ownAgent: boolean, underTabs = false): { row: boolean; paneStatus: boolean } {
  const lean = split || underTabs;
  // The window's own agent that ended is told by its exit banner, and its state by the header: only a shell's or another session's exit is not.
  const amiss = (pane.state === 'exited' && !ownAgent) || pane.state === 'detached' || pane.state === 'unavailable';
  return { row: !lean || astray || problem || amiss, paneStatus: !lean || amiss };
}

/**
 * Whether a body shows its agent's own pane: while no shell tab or other surface covers it, whether its tabs are on its
 * own strip or in a pop-up's row.
 */
export function ownPaneShown(panes: { showing(key: string): boolean } | undefined): boolean {
  return panes === undefined || panes.showing(OWN_SURFACE);
}
