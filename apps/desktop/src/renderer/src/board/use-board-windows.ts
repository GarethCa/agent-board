import { useCallback, useRef } from 'react';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import type { ScreenPoint, ShellChange } from '../../../preload/api';
import { tabWindowTitle } from '../session/tabs';
import type { SurfaceMove } from '../session/shell-moves';
import { windowsClosedBy } from '../windows/session-windows';
import { useSessionWindows } from '../windows/SessionWindows';

/** What a shell tile's window calls it. */
export function shellTitle(shell: Shell): string {
  return `${shell.name} · ${shell.cwd}`;
}

/** What an agent's session window calls it. */
export function agentTitle(agent: Agent): string {
  return `${agent.name} · ${agent.branch}`;
}

/**
 * The board's session windows, as the board opens and closes them for its tiles: an agent's or shell's window, a tab
 * window, and the windows a shell change closes.
 */
export function useBoardWindows() {
  const { windows, restored: windowsRestored, show: showWindow, close: closeWindow, popOut } = useSessionWindows();
  const windowsRef = useRef(windows);
  windowsRef.current = windows;
  /** Pops out the tab window a tab went into, if it isn't out already (a redo of its pop-out). */
  const popOutTabWindow = useCallback(
    (owner: { kind: string; id: string } | undefined, surface: SurfaceMove['surface'], at?: ScreenPoint) => {
      if (owner?.kind !== 'tabs' || windowsRef.current.some((entry) => entry.id === owner.id)) return;
      popOut({ kind: 'tabs', id: owner.id, title: tabWindowTitle(surface) }, at);
    },
    [popOut],
  );
  const openShell = useCallback((shell: Shell) => showWindow({ kind: 'shell', id: shell.id, title: shellTitle(shell) }), [showWindow]);
  const openAgent = useCallback(
    (agent: Agent) => showWindow({ kind: 'session', id: agent.sessionId, title: agentTitle(agent) }),
    [showWindow],
  );
  /**
   * Whether the agent's window is popped out into an OS window of its own. That runs in another renderer, which can't
   * hear a tab asked for: it is only brought forward, and nothing is left waiting for the next window on the board.
   */
  const poppedOut = useCallback((sessionId: string) => windowsRef.current.some((entry) => entry.id === sessionId && entry.placement === 'popped'), []);
  /** Closes the session windows a shell change leaves with nothing to show. */
  const onShellChange = useCallback(
    (change: ShellChange) => {
      for (const id of windowsClosedBy(windowsRef.current, change)) closeWindow(id);
    },
    [closeWindow],
  );

  return { windows, windowsRestored, windowsRef, showWindow, closeWindow, popOut, popOutTabWindow, openShell, openAgent, poppedOut, onShellChange };
}
