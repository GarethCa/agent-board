import { useCallback, useRef, type RefObject } from 'react';
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

/** Whether an agent's tile stays on the board, opened by `path`, in place of its session window: handled if so. */
export type KeptOnBoard = (sessionId: string, path: string) => boolean;

/** No agent kept on the board. */
const NONE_KEPT: RefObject<KeptOnBoard> = { current: () => false };

/**
 * The board's session windows, as the board opens and closes them for its tiles: an agent's or shell's window, a tab
 * window, and the windows a shell change closes. An agent `kept` on the board (pinned expanded) opens no window: its
 * tile is shown instead, by whatever asked for the window (Maximise, Pop out, a notification, a message, ⌘K in a
 * popped-out window). Every way to a session window comes through here, so none can get past.
 */
export function useBoardWindows(kept: RefObject<KeptOnBoard> = NONE_KEPT) {
  const { windows, restored: windowsRestored, show: showAnyWindow, close: closeWindow, popOut: popOutWindow } = useSessionWindows();
  const showWindow = useCallback(
    (target: Parameters<typeof showAnyWindow>[0], path = 'showWindow') => {
      if (target.kind === 'session' && kept.current(target.id, path)) return;
      showAnyWindow(target);
    },
    [showAnyWindow, kept],
  );
  const popOut = useCallback(
    (...args: Parameters<typeof popOutWindow>) => {
      const [target] = args;
      if (target.kind === 'session' && kept.current(target.id, 'popOut')) return;
      popOutWindow(...args);
    },
    [popOutWindow, kept],
  );
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
    (agent: Agent) => showWindow({ kind: 'session', id: agent.sessionId, title: agentTitle(agent) }, 'openAgent'),
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
